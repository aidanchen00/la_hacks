"""
Prana Agentverse Agent — the ASI:One / OmegaClaw-facing entry point.

Responsibilities:
- Registered on Agentverse as a discoverable wellness-navigation skill
- Implements Chat Protocol so ASI:One / OmegaClaw can send a health request and receive a RoutingDecision
- Implements Payment Protocol (Stripe horoscope pattern) for optional paid navigation
- Polls SQLite every 3s for pending web-triggered runs and routes them via LLM

To run:
    cd /Users/aidanchen/projects/la_hacks
    python agents/run_all.py
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[2] / ".env")

import httpx
import openai
from uagents import Agent, Context, Protocol

from uagents_core.contrib.protocols.chat import (  # type: ignore
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    TextContent,
    chat_protocol_spec,
)
from uagents_core.contrib.protocols.payment import (  # type: ignore
    CommitPayment,
    CompletePayment,
    RejectPayment,
    RequestPayment,
    Funds,
    payment_protocol_spec,
)

from agents.shared.messages import (
    AppointmentResult, AppointmentSearchRequest,
    BudgetRequest, RoutingDecision, SpecialistResult,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("prana-agent")

# ---------------------------------------------------------------------------
# Agent setup
# ---------------------------------------------------------------------------

PRANA_SEED = os.getenv("PRANA_SEED", "prana-la-hacks-2026-seed-phrase-abc123")
DATABASE_PATH = str(Path(__file__).resolve().parents[2] / "prana.db")
FASTAPI_CALLBACK_URL = os.getenv("FASTAPI_CALLBACK_URL", "http://localhost:8000/internal/agent-event")
FASTAPI_BASE_URL = os.getenv("FASTAPI_BASE_URL", "http://localhost:8000")
APP_URL = os.getenv("APP_URL", "http://localhost:3000")

# Realistic out-of-pocket doctor visit costs (USD)
DOCTOR_COSTS = {
    "emergency":  ("Emergency Care Consultation",  350.00),
    "urgent":     ("Urgent Care Visit",            175.00),
    "routine":    ("Primary Care Appointment",     150.00),
    "wellness":   ("Wellness / Preventive Checkup", 120.00),
}

DEFAULT_SHOPPING_BUDGET_USD = float(os.getenv("DEFAULT_SHOPPING_BUDGET_USD", "100.0"))

def _budget_agent_address() -> str:
    from uagents.crypto import Identity
    return Identity.from_seed("budget-la-hacks-2026-seed-phrase-xyz789", 0).address

BUDGET_AGENT_ADDRESS = os.getenv("BUDGET_AGENT_ADDRESS", "")

prana = Agent(
    name="prana",
    seed=PRANA_SEED,
    port=8100,
    mailbox=True,
    publish_agent_details=True,
    readme_path=str(Path(__file__).parent / "README.md"),
    network="testnet",
)

logger.info(f"Prana agent address: {prana.address}")

# In-memory store for ASI:One sender addresses
_pending_chat: Dict[str, str] = {}     # run_id → sender_address (routing phase)
_pharmacy_chat: Dict[str, str] = {}   # run_id → sender_address (waiting for shopping results)
_doctor_chat: Dict[str, str] = {}     # run_id → sender_address (waiting for appointment results)
_doctor_state: Dict[str, Dict[str, Any]] = {}   # run_id → { expected, decision, results }


def _appointment_address(seed: str) -> str:
    from uagents.crypto import Identity
    return Identity.from_seed(seed, 0).address


APPOINTMENT_AGENTS = {
    "zocdoc":       _appointment_address("zocdoc-seller-seed-la-hacks-2026"),
    "healthgrades": _appointment_address("healthgrades-seller-seed-la-hacks-2026"),
    "solv":         _appointment_address("solv-seller-seed-la-hacks-2026"),
}

# ---------------------------------------------------------------------------
# LLM routing (same logic as api/routing.py but runs in-agent)
# ---------------------------------------------------------------------------

ROUTING_SYSTEM = """You are the Prana Orchestrator. If intake history is provided below, use it to personalize the response and reference specific past symptoms / prior recommendations. If no history is provided, classify the current message on its own.

PATHS: doctor | pharmacy | mental_health | alt_medicine | self_care
URGENCY: emergency | urgent | routine | wellness

How to pick the path (apply in order, first match wins):
1. emergency → user describes life-threatening symptoms (chest pain, stroke signs, severe bleeding). Set urgency=emergency.
2. doctor → user wants to see a clinician or describes symptoms that need a clinical visit (rashes, persistent infection, suspected fracture, prescription renewal that requires a provider).
3. pharmacy → user wants to BUY an over-the-counter (OTC) medication, supplement, or wellness product. Triggers include: "buy", "order", "where can I get", "find me", "shop for", "add to cart", explicit OTC drug names (ibuprofen, acetaminophen, Mucinex, Tylenol, Sudafed, Pepto, Claritin, melatonin), or naming a pharmacy ("CVS", "Walgreens", "GoodRx"). Pick this path even when symptoms are mild — purchase intent overrides wellness/self-care.
4. mental_health → anxiety, depression, stress, sleep issues, mood — intent is emotional support / journaling / mental wellness.
5. alt_medicine → herbal remedies, supplements without purchase intent, traditional medicine questions.
6. self_care → general lifestyle / wellness questions with no purchase intent and no clinical need (hydration, exercise, diet tips).

Rules:
- emergency → include a "Call 911 immediately" disclaimer.
- requires_doctor_approval = true ONLY when pharmacy path and the medication is Rx (e.g. antibiotics, controlled substances). False for OTC.
- Never diagnose; use "may indicate", "consider consulting".
- If the user references "last time" / "continue" / "what did you say", reference their history.

For doctor path, also pick:
- specialty: the medical specialty most relevant ("primary care", "urgent care", "dermatology", "cardiology", "psychiatry", etc.). Default to "primary care" if unclear.
- location: extract a US city/area from the message/history if mentioned, otherwise "Los Angeles, CA".
For pharmacy path, also pick:
- query: 3-6 word OTC search phrase ("cold and flu relief", "ibuprofen 200mg", "melatonin sleep aid").

Examples:
- "Buy me ibuprofen from CVS" → pharmacy, query="ibuprofen", requires_doctor_approval=false.
- "I have a headache, what can I take?" → pharmacy, query="OTC pain relief".
- "I think I broke my wrist" → doctor, specialty="urgent care", urgency=urgent.
- "How much water should I drink daily?" → self_care.
- "I've been anxious all week" → mental_health.

Return ONLY valid JSON:
{
  "urgency": "...",
  "recommended_path": "...",
  "summary": "2-3 sentences",
  "next_actions": ["..."],
  "payment_required": false,
  "payment_amount_usd": 0.0,
  "requires_doctor_approval": false,
  "rationale": "...",
  "disclaimers": ["Prana is a wellness education tool..."],
  "specialty": "primary care",
  "location": "Los Angeles, CA",
  "query": "cold and flu relief"
}"""


_openai_client: openai.AsyncOpenAI | None = None


def _get_openai_client() -> openai.AsyncOpenAI:
    global _openai_client
    if _openai_client is not None:
        return _openai_client
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        # Defensive reload — handles cases where the process started before .env was populated
        load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)
        api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "OPENAI_API_KEY not set. Add it to /Users/aidanchen/projects/la_hacks/.env "
            "and restart the agent (python agents/run_all.py)."
        )
    _openai_client = openai.AsyncOpenAI(api_key=api_key)
    return _openai_client


async def route_text(text: str, context: str = "") -> Dict[str, Any]:
    client = _get_openai_client()
    user_message = f"{context}\n\nCurrent message: {text}" if context else text
    try:
        resp = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": ROUTING_SYSTEM},
                {"role": "user", "content": user_message},
            ],
            temperature=0,
            max_tokens=600,
        )
        raw = (resp.choices[0].message.content or "{}").strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        return json.loads(raw.strip())
    except Exception as e:
        logger.error(f"[route_text] LLM error: {e}")
        return {
            "urgency": "wellness",
            "recommended_path": "self_care",
            "summary": "Wellness intake recorded. Please review your dashboard.",
            "next_actions": ["Open your Prana dashboard", "Consult a healthcare professional if needed"],
            "payment_required": False,
            "payment_amount_usd": 0.0,
            "requires_doctor_approval": False,
            "rationale": f"LLM error fallback: {str(e)[:60]}",
            "disclaimers": ["Prana is a wellness education tool, not a medical diagnosis service."],
        }


# ---------------------------------------------------------------------------
# SQLite helpers (mirrors api/db.py but avoids circular import)
# ---------------------------------------------------------------------------

def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(DATABASE_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _ensure_schema() -> None:
    """Create tables if they don't exist — so agent works without FastAPI running."""
    conn = _db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY,
            user_id INTEGER,
            status TEXT NOT NULL DEFAULT 'pending',
            instruction TEXT,
            intake_summary TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS routing_decisions (
            run_id TEXT PRIMARY KEY,
            urgency TEXT NOT NULL DEFAULT 'wellness',
            recommended_path TEXT NOT NULL DEFAULT 'self_care',
            summary TEXT,
            next_actions TEXT NOT NULL DEFAULT '[]',
            payment_required INTEGER NOT NULL DEFAULT 0,
            payment_amount REAL NOT NULL DEFAULT 0,
            requires_doctor_approval INTEGER NOT NULL DEFAULT 0,
            rationale TEXT,
            disclaimers TEXT NOT NULL DEFAULT '[]',
            specialty TEXT,
            location TEXT,
            search_query TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS agent_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            agent_name TEXT,
            event_type TEXT,
            payload TEXT NOT NULL DEFAULT '{}',
            timestamp TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS budget_sessions (
            run_id TEXT PRIMARY KEY,
            total_budget_usd REAL NOT NULL,
            per_agent_usd REAL NOT NULL,
            num_agents INTEGER NOT NULL DEFAULT 4,
            agents_done INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'allocating',
            stripe_session_id TEXT,
            checkout_url TEXT,
            requester_address TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS agent_wallets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            agent_name TEXT NOT NULL,
            allocated_usd REAL NOT NULL DEFAULT 0,
            spent_usd REAL NOT NULL DEFAULT 0,
            balance_usd REAL NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
            funded_at TEXT,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(run_id, agent_name)
        );
        CREATE TABLE IF NOT EXISTS shopping_cart (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            agent_name TEXT NOT NULL,
            platform TEXT NOT NULL,
            item_name TEXT,
            item_price REAL NOT NULL DEFAULT 0,
            item_url TEXT,
            in_stock INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
        CREATE INDEX IF NOT EXISTS idx_events_run ON agent_events(run_id);
    """)
    # Backfill columns for older DBs (sqlite has no IF NOT EXISTS for ADD COLUMN)
    for col_def in ("specialty TEXT", "location TEXT", "search_query TEXT"):
        try:
            conn.execute(f"ALTER TABLE routing_decisions ADD COLUMN {col_def}")
        except sqlite3.OperationalError:
            pass
    conn.commit()
    conn.close()
    logger.info("[db] Schema ensured")


# Call once all helpers are defined
_ensure_schema()


def _create_run(run_id: str, text: str) -> None:
    conn = _db()
    conn.execute(
        "INSERT OR IGNORE INTO runs (id, instruction, status) VALUES (?, ?, 'pending')",
        (run_id, text),
    )
    conn.commit()
    conn.close()


def _save_routing(run_id: str, decision: Dict[str, Any]) -> None:
    conn = _db()
    conn.execute(
        """INSERT OR REPLACE INTO routing_decisions
           (run_id, urgency, recommended_path, summary, next_actions, payment_required,
            payment_amount, requires_doctor_approval, rationale, disclaimers,
            specialty, location, search_query)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            run_id, decision.get("urgency", "wellness"),
            decision.get("recommended_path", "self_care"),
            decision.get("summary"), json.dumps(decision.get("next_actions", [])),
            int(decision.get("payment_required", False)),
            float(decision.get("payment_amount_usd", 0)),
            int(decision.get("requires_doctor_approval", False)),
            decision.get("rationale"), json.dumps(decision.get("disclaimers", [])),
            decision.get("specialty"), decision.get("location"),
            decision.get("query") or decision.get("search_query"),
        ),
    )
    conn.execute(
        "UPDATE runs SET status = 'routed', updated_at = datetime('now') WHERE id = ?",
        (run_id,),
    )
    conn.commit()
    conn.close()


def _get_pending_run() -> Optional[Dict[str, Any]]:
    conn = _db()
    row = conn.execute(
        "SELECT id, instruction FROM runs WHERE status = 'pending' ORDER BY created_at LIMIT 1"
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def _build_user_context() -> str:
    """Fetch the most recent completed intake + routing decision from SQLite."""
    try:
        conn = _db()
        row = conn.execute("""
            SELECT r.id, r.instruction, r.intake_summary, r.created_at,
                   rd.urgency, rd.recommended_path, rd.summary AS rd_summary,
                   rd.next_actions
            FROM runs r
            LEFT JOIN routing_decisions rd ON rd.run_id = r.id
            WHERE r.status IN ('routed', 'paid', 'in_progress')
            ORDER BY r.created_at DESC
            LIMIT 1
        """).fetchone()
        conn.close()

        if not row:
            return ""

        row = dict(row)
        date = (row.get("created_at") or "")[:16]
        intake_text = row.get("intake_summary") or row.get("instruction") or ""
        rd_summary = row.get("rd_summary") or ""
        urgency = row.get("urgency") or ""
        path = row.get("recommended_path") or ""
        next_actions = []
        try:
            next_actions = json.loads(row.get("next_actions") or "[]")
        except Exception:
            pass

        lines = [
            f"=== MOST RECENT INTAKE ({date}, run: {row['id'][:8]}) ===",
            f"What the user said: {intake_text[:400]}",
        ]
        if rd_summary:
            lines.append(f"Prior assessment: {rd_summary}")
        if urgency:
            lines.append(f"Urgency: {urgency} | Routed to: {path}")
        if next_actions:
            lines.append("Prior next actions: " + "; ".join(next_actions[:3]))
        lines.append("=== END OF PRIOR INTAKE ===")
        return "\n".join(lines)
    except Exception as e:
        logger.warning(f"[context] Failed to build user context: {e}")
        return ""


# ---------------------------------------------------------------------------
# FastAPI event callback
# ---------------------------------------------------------------------------

async def _post_event(run_id: str, event_type: str, payload: Dict[str, Any]) -> None:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(FASTAPI_CALLBACK_URL, json={
                "run_id": run_id,
                "agent_name": "prana",
                "event_type": event_type,
                "payload": payload,
            })
    except Exception as e:
        logger.warning(f"[post_event] Failed: {e}")


# ---------------------------------------------------------------------------
# SQLite polling — picks up web-triggered runs
# ---------------------------------------------------------------------------

async def _trigger_budget(ctx: Context, run_id: str, instruction: str,
                           decision: Dict[str, Any]) -> None:
    """Send BudgetRequest to budget agent for pharmacy routing decisions."""
    budget_addr = BUDGET_AGENT_ADDRESS or _budget_agent_address()
    query = decision.get("summary", instruction)[:200]
    budget_req = BudgetRequest(
        run_id=run_id,
        query=query,
        total_budget_usd=DEFAULT_SHOPPING_BUDGET_USD,
        requester_address=prana.address,
    )
    try:
        await ctx.send(budget_addr, budget_req)
        logger.info(f"[prana] BudgetRequest sent to budget agent for run {run_id[:8]} "
                    f"(${DEFAULT_SHOPPING_BUDGET_USD:.2f})")
    except Exception as e:
        logger.error(f"[prana] Failed to send BudgetRequest: {e}")


async def _trigger_doctor_payment(run_id: str, urgency: str) -> tuple[Optional[str], str, float]:
    """Create a Stripe checkout for a doctor appointment immediately.
    Returns (checkout_url, item_name, amount_usd)."""
    item_name, amount = DOCTOR_COSTS.get(urgency, DOCTOR_COSTS["routine"])
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{FASTAPI_BASE_URL}/pay/checkout",
                json={"run_id": run_id, "amount": amount, "item_name": item_name},
            )
            if resp.status_code == 200:
                checkout_url = resp.json().get("url")
                logger.info(f"[doctor] Stripe checkout created for run {run_id[:8]} — ${amount:.2f}")
                return checkout_url, item_name, amount
    except Exception as e:
        logger.error(f"[doctor] Failed to create Stripe checkout: {e}")
    return None, item_name, amount


async def _trigger_doctor_search(ctx: Context, run_id: str, decision: Dict[str, Any]) -> None:
    """Fan out AppointmentSearchRequest to ZocDoc / Healthgrades / Solv."""
    specialty = (decision.get("specialty") or "primary care").strip()
    location = (decision.get("location") or "Los Angeles, CA").strip()
    _doctor_state[run_id] = {
        "expected": set(APPOINTMENT_AGENTS.keys()),
        "results": [],            # list of AppointmentResult
        "decision": decision,
        "specialty": specialty,
        "location": location,
    }
    for name, addr in APPOINTMENT_AGENTS.items():
        req = AppointmentSearchRequest(
            run_id=run_id, query=specialty, location=location,
            requester_address=prana.address,
        )
        try:
            await ctx.send(addr, req)
            logger.info(f"[doctor] AppointmentSearchRequest → {name} (run {run_id[:8]})")
        except Exception as e:
            logger.error(f"[doctor] send to {name} failed: {e}")
    await _post_event(run_id, "doctor_search_started", {
        "specialty": specialty, "location": location, "agents": list(APPOINTMENT_AGENTS.keys()),
    })


async def _finalize_doctor_run(ctx: Context, run_id: str) -> None:
    """All 3 appointment agents reported in — rank, checkout, follow-up chat."""
    state = _doctor_state.pop(run_id, None)
    sender = _doctor_chat.pop(run_id, None)
    if not state or not sender:
        return

    decision = state["decision"]
    urgency = decision.get("urgency", "routine")
    item_name, amount = DOCTOR_COSTS.get(urgency, DOCTOR_COSTS["routine"])

    # Flatten parsed providers into ranker candidates
    candidates: List[Dict[str, Any]] = []
    by_site: Dict[str, int] = {}
    for r in state["results"]:
        by_site[r.platform] = len(r.providers)
        for p in r.providers:
            candidates.append({
                "source_agent": r.platform,
                "name": p.get("provider", "Unknown provider"),
                "price": amount,    # visit fee, same across providers
                "url": p.get("listingUrl"),
                "description": (
                    f"{p.get('specialty', '')} · {p.get('address', '')}".strip(" ·")
                    if (p.get("specialty") or p.get("address")) else None
                ),
                "metadata": {
                    "specialty": p.get("specialty"),
                    "time": p.get("time"),
                    "address": p.get("address"),
                    "accepts_insurance": p.get("acceptsInsurance"),
                },
            })

    summary_lines = [f"🏥 Appointment search complete (run: {run_id[:8]})"]
    summary_lines.append(
        " · ".join(f"{site}: {n}" for site, n in by_site.items())
        or "No providers parsed."
    )

    checkout_url: Optional[str] = None
    pick_name: str = ""
    pick_url: Optional[str] = None
    pick_time: Optional[str] = None

    if candidates:
        try:
            async with httpx.AsyncClient(timeout=45.0) as client:
                rank_resp = await client.post(
                    f"{FASTAPI_BASE_URL}/rank/{run_id}",
                    json={
                        "domain": "doctor",
                        "query": state["specialty"],
                        "intake_summary": decision.get("summary", ""),
                        "urgency": urgency,
                        "requires_doctor_approval": False,
                        "total_budget_usd": amount,
                        "per_agent_budget_usd": amount,
                        "candidates": candidates,
                    },
                )
                rank_data = rank_resp.json() if rank_resp.status_code == 200 else {}
        except Exception as e:
            logger.error(f"[doctor] ranker call failed: {e}")
            rank_data = {}

        # Pull persisted selection so we have the row id required by /doctor/checkout
        selected_items: List[Dict[str, Any]] = []
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                sel_resp = await client.get(f"{FASTAPI_BASE_URL}/rank/{run_id}", params={"domain": "doctor"})
                if sel_resp.status_code == 200:
                    selected_items = sel_resp.json().get("selected", []) or []
        except Exception as e:
            logger.error(f"[doctor] ranker fetch failed: {e}")

        if selected_items:
            top = selected_items[0]
            pick_name = top.get("name", "")
            pick_url = top.get("url")
            pick_time = (top.get("metadata") or {}).get("time")
            checkout_payload = {
                "run_id": run_id,
                "items": [{
                    "id": top.get("id"),
                    "name": top.get("name"),
                    "price": top.get("price", amount),
                    "source_agent": top.get("source_agent"),
                    "description": top.get("description"),
                }],
            }
            try:
                async with httpx.AsyncClient(timeout=15.0) as client:
                    co_resp = await client.post(f"{FASTAPI_BASE_URL}/doctor/checkout", json=checkout_payload)
                    if co_resp.status_code == 200:
                        checkout_url = co_resp.json().get("checkout_url")
            except Exception as e:
                logger.error(f"[doctor] checkout failed: {e}")
            rationale = (rank_data.get("selection_rationale") or "").strip()
            summary_lines.append(f"\n🎯 Ranker pick: {pick_name} ({top.get('source_agent', '?')})")
            if pick_time:
                summary_lines.append(f"🗓 Earliest: {pick_time}")
            if rationale:
                summary_lines.append(f"💭 {rationale}")

    if checkout_url:
        summary_lines.append(
            f"\n💳 Book & Pay — {item_name}: ${amount:.2f}\n{checkout_url}\n"
            f"Test card: 4242 4242 4242 4242 · any future date · any CVV"
        )
    else:
        # Fall back to a generic visit checkout if ranker / persistence failed
        fallback_url, _, _ = await _trigger_doctor_payment(run_id, urgency)
        if fallback_url:
            summary_lines.append(
                f"\n💳 Book & Pay — {item_name}: ${amount:.2f}\n{fallback_url}\n"
                f"Test card: 4242 4242 4242 4242 · any future date · any CVV"
            )
        else:
            summary_lines.append(f"\n💳 {item_name}: ${amount:.2f} (payment link unavailable)")

    if pick_url:
        summary_lines.append(f"🔗 Provider listing: {pick_url}")
    summary_lines.append(f"📊 Doctor page: {APP_URL}/doctor/{run_id}")
    summary_lines.append(f"📊 Full dashboard: {APP_URL}/dashboard?run_id={run_id}")

    await ctx.send(sender, ChatMessage(
        timestamp=datetime.utcnow(), msg_id=uuid4(),
        content=[
            TextContent(type="text", text="\n".join(summary_lines)),
            EndSessionContent(type="end-session"),
        ],
    ))


@prana.on_interval(period=3.0)
async def poll_pending_runs(ctx: Context) -> None:
    run = _get_pending_run()
    if not run:
        return

    run_id, instruction = run["id"], run.get("instruction", "")
    logger.info(f"[prana] Picked up pending run {run_id[:8]}")

    # Mark in_progress immediately to avoid re-picking
    conn = _db()
    conn.execute("UPDATE runs SET status = 'in_progress' WHERE id = ?", (run_id,))
    conn.commit()
    conn.close()

    decision = await route_text(instruction)
    decision["run_id"] = run_id
    _save_routing(run_id, decision)
    await _post_event(run_id, "routing_complete", decision)
    logger.info(f"[prana] run {run_id[:8]} → {decision.get('recommended_path')} ({decision.get('urgency')})")

    if decision.get("recommended_path") == "pharmacy":
        await _trigger_budget(ctx, run_id, instruction, decision)
    elif decision.get("recommended_path") == "doctor":
        checkout_url, item_name, amount = await _trigger_doctor_payment(run_id, decision.get("urgency", "routine"))
        if checkout_url:
            await _post_event(run_id, "doctor_checkout_ready", {
                "checkout_url": checkout_url, "item_name": item_name, "amount_usd": amount,
            })


# ---------------------------------------------------------------------------
# Chat Protocol — ASI:One / OmegaClaw interface
# ---------------------------------------------------------------------------

chat_proto = Protocol(spec=chat_protocol_spec)


@chat_proto.on_message(ChatMessage)
async def handle_chat(ctx: Context, sender: str, msg: ChatMessage) -> None:
    await ctx.send(sender, ChatAcknowledgement(
        timestamp=datetime.utcnow(), acknowledged_msg_id=msg.msg_id,
    ))

    text = " ".join(item.text for item in msg.content if isinstance(item, TextContent)).strip()
    logger.info(f"[chat] From {sender[:20]}: {text[:80]}")

    if not text:
        await ctx.send(sender, ChatMessage(
            timestamp=datetime.utcnow(), msg_id=uuid4(),
            content=[
                TextContent(type="text", text="Please describe your health or wellness concern and I'll route you to the appropriate care resource."),
                EndSessionContent(type="end-session"),
            ],
        ))
        return

    # Load full user history from DB before routing
    user_context = _build_user_context()
    context_note = " I've loaded your full intake history to personalize this." if user_context else ""

    await ctx.send(sender, ChatMessage(
        timestamp=datetime.utcnow(), msg_id=uuid4(),
        content=[TextContent(type="text", text=f"Analyzing your wellness intake…{context_note} Please wait a moment.")],
    ))

    run_id = str(uuid4())
    try:
        _create_run(run_id, text)
        _pending_chat[run_id] = sender

        decision = await route_text(text, context=user_context)
        decision["run_id"] = run_id
        _save_routing(run_id, decision)
        await _post_event(run_id, "routing_complete", decision)
        logger.info(f"[chat] Routed run {run_id[:8]} → {decision.get('recommended_path')} ({decision.get('urgency')})")
    except Exception as e:
        logger.error(f"[chat] Routing failed for run {run_id[:8]}: {e}", exc_info=True)
        await ctx.send(sender, ChatMessage(
            timestamp=datetime.utcnow(), msg_id=uuid4(),
            content=[
                TextContent(type="text", text=f"Sorry, Prana encountered an error while processing your intake: {e}\n\nPlease try again."),
                EndSessionContent(type="end-session"),
            ],
        ))
        return

    recommended_path = decision.get("recommended_path", "self_care")

    doctor_searching = False
    try:
        if recommended_path == "pharmacy":
            _pharmacy_chat[run_id] = sender
            await _trigger_budget(ctx, run_id, text, decision)
            logger.info(f"[chat] Budget trigger sent for pharmacy run {run_id[:8]}")
        elif recommended_path == "doctor":
            _doctor_chat[run_id] = sender
            await _trigger_doctor_search(ctx, run_id, decision)
            doctor_searching = True
            logger.info(f"[chat] Doctor search dispatched for run {run_id[:8]} "
                        f"(specialty='{decision.get('specialty')}', loc='{decision.get('location')}')")
    except Exception as e:
        logger.error(f"[chat] Downstream trigger failed for run {run_id[:8]}: {e}", exc_info=True)

    # Build deep link to the right page
    path_routes = {
        "doctor": f"{APP_URL}/doctor/{run_id}",
        "pharmacy": f"{APP_URL}/pharmacy/{run_id}",
        "mental_health": f"{APP_URL}/memory-world/{run_id}",
        "alt_medicine": f"{APP_URL}/alt-medicine/{run_id}",
        "self_care": f"{APP_URL}/graph",
    }
    deep_link = path_routes.get(recommended_path, f"{APP_URL}/dashboard?run_id={run_id}")
    dashboard_link = f"{APP_URL}/dashboard?run_id={run_id}"

    history_note = "\n📋 Context: Personalized based on your intake history.\n" if user_context else ""

    payment_block = ""
    if recommended_path == "doctor":
        sites = ", ".join(s.title() for s in APPOINTMENT_AGENTS.keys())
        payment_block = (
            f"\n🔍 Searching {sites} for {decision.get('specialty', 'primary care')} "
            f"in {decision.get('location', 'Los Angeles, CA')}…\n"
            f"I'll send the booking link in ~60–90s once the agents return.\n"
        )

    result_text = (
        f"🏥 Prana Routing Decision (run: {run_id[:8]})\n"
        f"{history_note}\n"
        f"Urgency: {decision.get('urgency', 'wellness').upper()}\n"
        f"Recommended Path: {recommended_path.replace('_', ' ').title()}\n\n"
        f"{decision.get('summary', '')}\n\n"
        f"Next Actions:\n" + "\n".join(f"• {a}" for a in decision.get("next_actions", [])) +
        f"{payment_block}\n"
        f"🔗 Open your care page:\n{deep_link}\n\n"
        f"📊 Full dashboard:\n{dashboard_link}\n\n"
        + "\n".join(decision.get("disclaimers", []))
    )

    # For pharmacy / doctor, don't end session — waiting for async results
    content = [TextContent(type="text", text=result_text)]
    if recommended_path not in ("pharmacy", "doctor"):
        content.append(EndSessionContent(type="end-session"))

    await ctx.send(sender, ChatMessage(
        timestamp=datetime.utcnow(), msg_id=uuid4(),
        content=content,
    ))

    _pending_chat.pop(run_id, None)


@chat_proto.on_message(ChatAcknowledgement)
async def handle_ack(_ctx: Context, _sender: str, _msg: ChatAcknowledgement) -> None:
    pass


prana.include(chat_proto, publish_manifest=True)


@prana.on_message(AppointmentResult)
async def handle_appointment_result(ctx: Context, sender: str, msg: AppointmentResult) -> None:
    """Collect ZocDoc/Healthgrades/Solv results; finalize once all 3 returned."""
    state = _doctor_state.get(msg.run_id)
    if not state:
        logger.warning(f"[doctor] AppointmentResult for unknown run {msg.run_id[:8]}")
        return
    state["results"].append(msg)
    state["expected"].discard(msg.agent_name)
    logger.info(f"[doctor] {msg.agent_name} returned {len(msg.providers)} provider(s) "
                f"(remaining: {sorted(state['expected'])})")
    await _post_event(msg.run_id, "appointment_result", {
        "agent": msg.agent_name, "platform": msg.platform,
        "count": len(msg.providers), "error": msg.error,
    })
    if not state["expected"]:
        await _finalize_doctor_run(ctx, msg.run_id)


@prana.on_message(SpecialistResult)
async def handle_specialist_result(ctx: Context, sender: str, msg: SpecialistResult) -> None:
    """Receive shopping results from budget agent and relay to ASI:One."""
    run_id = msg.run_id
    checkout_url = msg.artifacts.get("checkout_url")
    items = msg.artifacts.get("items", [])

    await _post_event(run_id, "shopping_complete", msg.artifacts)
    logger.info(f"[prana] Shopping complete for run {run_id[:8]}: "
                f"{len(items)} items, checkout={'yes' if checkout_url else 'no'}")

    pending_sender = _pharmacy_chat.pop(run_id, None)
    if not pending_sender:
        return

    summary_lines = [
        f"💊 Shopping Complete — {len(items)} products found across CVS, Walgreens, GoodRx & Amazon:\n"
    ]
    for item in items:
        status = "✅ In Stock" if item.get("in_stock") else "❌ Out of Stock"
        summary_lines.append(
            f"• {item.get('platform')}: {item.get('item') or 'No result'} "
            f"${item.get('price', 0):.2f} — {status}"
        )
    if checkout_url:
        summary_lines.append(f"\n💳 Checkout (Stripe test): {checkout_url}")
        summary_lines.append("Test card: 4242 4242 4242 4242 · any future date · any CVV")
    else:
        summary_lines.append("\nNo items available for checkout.")

    summary_lines.append(f"\n🔗 View pharmacy page: {APP_URL}/pharmacy/{run_id}")
    summary_lines.append(f"📊 Full dashboard: {APP_URL}/dashboard?run_id={run_id}")

    await ctx.send(pending_sender, ChatMessage(
        timestamp=datetime.utcnow(), msg_id=uuid4(),
        content=[
            TextContent(type="text", text="\n".join(summary_lines)),
            EndSessionContent(type="end-session"),
        ],
    ))


# ---------------------------------------------------------------------------
# Payment Protocol (Fetch.ai standard — Stripe horoscope pattern)
# ---------------------------------------------------------------------------

payment_proto = Protocol(spec=payment_protocol_spec, role="seller")


@payment_proto.on_message(CommitPayment)
async def on_commit_payment(ctx: Context, sender: str, msg: CommitPayment) -> None:
    session_id = msg.transaction_id
    logger.info(f"[payment] CommitPayment from {sender[:20]} — verifying {session_id[:20]}")

    try:
        import stripe as stripe_lib
        stripe_lib.api_key = os.getenv("STRIPE_SECRET_KEY", "")
        session = stripe_lib.checkout.Session.retrieve(session_id)
        if session.payment_status != "paid":
            await ctx.send(sender, RejectPayment(reason="Stripe session not yet paid."))
            return
    except Exception as e:
        await ctx.send(sender, RejectPayment(reason=f"Stripe verification failed: {e}"))
        return

    await ctx.send(sender, CompletePayment(transaction_id=session_id))
    logger.info(f"[payment] Verified and confirmed payment {session_id[:16]}")

    await ctx.send(sender, ChatMessage(
        timestamp=datetime.utcnow(), msg_id=uuid4(),
        content=[TextContent(type="text", text="Payment confirmed! You can now access full Prana navigation services.")],
    ))


@payment_proto.on_message(RejectPayment)
async def on_reject_payment(ctx: Context, sender: str, msg: RejectPayment) -> None:
    logger.info(f"[payment] Rejected by {sender[:20]}: {getattr(msg, 'reason', '')}")
    await ctx.send(sender, ChatMessage(
        timestamp=datetime.utcnow(), msg_id=uuid4(),
        content=[
            TextContent(type="text", text="Payment declined. You can still access free wellness navigation."),
            EndSessionContent(type="end-session"),
        ],
    ))


prana.include(payment_proto, publish_manifest=True)
