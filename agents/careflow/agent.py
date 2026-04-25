"""
CareFlow Agentverse Agent — the ASI:One / OmegaClaw-facing entry point.

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

from agents.shared.messages import BudgetRequest, RoutingDecision, SpecialistResult

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("careflow-agent")

# ---------------------------------------------------------------------------
# Agent setup
# ---------------------------------------------------------------------------

CAREFLOW_SEED = os.getenv("CAREFLOW_SEED", "careflow-la-hacks-2026-seed-phrase-abc123")
DATABASE_PATH = str(Path(__file__).resolve().parents[2] / "careflow.db")
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

careflow = Agent(
    name="careflow",
    seed=CAREFLOW_SEED,
    port=8100,
    mailbox=True,
    publish_agent_details=True,
    readme_path=str(Path(__file__).parent / "README.md"),
    network="testnet",
)

logger.info(f"CareFlow agent address: {careflow.address}")

# In-memory store for ASI:One sender addresses
_pending_chat: Dict[str, str] = {}     # run_id → sender_address (routing phase)
_pharmacy_chat: Dict[str, str] = {}   # run_id → sender_address (waiting for shopping results)

# ---------------------------------------------------------------------------
# LLM routing (same logic as api/routing.py but runs in-agent)
# ---------------------------------------------------------------------------

ROUTING_SYSTEM = """You are the CareFlow Orchestrator. You have full access to this user's intake history below.
Use it to give a personalized, contextual routing decision — reference their specific past symptoms, trends, and prior recommendations where relevant.

PATHS: doctor | pharmacy | mental_health | alt_medicine | self_care
URGENCY: emergency | urgent | routine | wellness

Rules:
- emergency → call 911 disclaimer required
- requires_doctor_approval = true when pharmacy path and Rx medications may be involved
- Never diagnose; use "may indicate", "consider consulting"
- If the user asks about a past intake or says "last time" / "continue" / "what did you say", reference their history directly

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
  "disclaimers": ["CareFlow is a wellness education tool..."]
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
            "next_actions": ["Open your CareFlow dashboard", "Consult a healthcare professional if needed"],
            "payment_required": False,
            "payment_amount_usd": 0.0,
            "requires_doctor_approval": False,
            "rationale": f"LLM error fallback: {str(e)[:60]}",
            "disclaimers": ["CareFlow is a wellness education tool, not a medical diagnosis service."],
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
            payment_amount, requires_doctor_approval, rationale, disclaimers)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            run_id, decision.get("urgency", "wellness"),
            decision.get("recommended_path", "self_care"),
            decision.get("summary"), json.dumps(decision.get("next_actions", [])),
            int(decision.get("payment_required", False)),
            float(decision.get("payment_amount_usd", 0)),
            int(decision.get("requires_doctor_approval", False)),
            decision.get("rationale"), json.dumps(decision.get("disclaimers", [])),
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
                "agent_name": "careflow",
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
        requester_address=careflow.address,
    )
    try:
        await ctx.send(budget_addr, budget_req)
        logger.info(f"[careflow] BudgetRequest sent to budget agent for run {run_id[:8]} "
                    f"(${DEFAULT_SHOPPING_BUDGET_USD:.2f})")
    except Exception as e:
        logger.error(f"[careflow] Failed to send BudgetRequest: {e}")


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


@careflow.on_interval(period=3.0)
async def poll_pending_runs(ctx: Context) -> None:
    run = _get_pending_run()
    if not run:
        return

    run_id, instruction = run["id"], run.get("instruction", "")
    logger.info(f"[careflow] Picked up pending run {run_id[:8]}")

    # Mark in_progress immediately to avoid re-picking
    conn = _db()
    conn.execute("UPDATE runs SET status = 'in_progress' WHERE id = ?", (run_id,))
    conn.commit()
    conn.close()

    decision = await route_text(instruction)
    decision["run_id"] = run_id
    _save_routing(run_id, decision)
    await _post_event(run_id, "routing_complete", decision)
    logger.info(f"[careflow] run {run_id[:8]} → {decision.get('recommended_path')} ({decision.get('urgency')})")

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
                TextContent(type="text", text=f"Sorry, CareFlow encountered an error while processing your intake: {e}\n\nPlease try again."),
                EndSessionContent(type="end-session"),
            ],
        ))
        return

    recommended_path = decision.get("recommended_path", "self_care")

    doctor_checkout_url: Optional[str] = None
    doctor_item_name: str = ""
    doctor_amount: float = 0.0

    try:
        if recommended_path == "pharmacy":
            _pharmacy_chat[run_id] = sender
            await _trigger_budget(ctx, run_id, text, decision)
            logger.info(f"[chat] Budget trigger sent for pharmacy run {run_id[:8]}")
        elif recommended_path == "doctor":
            doctor_checkout_url, doctor_item_name, doctor_amount = await _trigger_doctor_payment(
                run_id, decision.get("urgency", "routine")
            )
            await _post_event(run_id, "doctor_checkout_ready", {
                "checkout_url": doctor_checkout_url, "item_name": doctor_item_name, "amount_usd": doctor_amount,
            })
            logger.info(f"[chat] Doctor checkout created for run {run_id[:8]}: ${doctor_amount}")
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
    if recommended_path == "doctor" and doctor_checkout_url:
        payment_block = (
            f"\n💳 Book & Pay — {doctor_item_name}: ${doctor_amount:.2f}\n"
            f"{doctor_checkout_url}\n"
            f"Test card: 4242 4242 4242 4242 · any future date · any CVV\n"
        )
    elif recommended_path == "doctor":
        payment_block = f"\n💳 {doctor_item_name}: ${doctor_amount:.2f} (payment link unavailable — check dashboard)\n"

    result_text = (
        f"🏥 CareFlow Routing Decision (run: {run_id[:8]})\n"
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

    # For pharmacy, don't end session — waiting for shopping results
    content = [TextContent(type="text", text=result_text)]
    if recommended_path != "pharmacy":
        content.append(EndSessionContent(type="end-session"))

    await ctx.send(sender, ChatMessage(
        timestamp=datetime.utcnow(), msg_id=uuid4(),
        content=content,
    ))

    _pending_chat.pop(run_id, None)


@chat_proto.on_message(ChatAcknowledgement)
async def handle_ack(_ctx: Context, _sender: str, _msg: ChatAcknowledgement) -> None:
    pass


careflow.include(chat_proto, publish_manifest=True)


@careflow.on_message(SpecialistResult)
async def handle_specialist_result(ctx: Context, sender: str, msg: SpecialistResult) -> None:
    """Receive shopping results from budget agent and relay to ASI:One."""
    run_id = msg.run_id
    checkout_url = msg.artifacts.get("checkout_url")
    items = msg.artifacts.get("items", [])

    await _post_event(run_id, "shopping_complete", msg.artifacts)
    logger.info(f"[careflow] Shopping complete for run {run_id[:8]}: "
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
        content=[TextContent(type="text", text="Payment confirmed! You can now access full CareFlow navigation services.")],
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


careflow.include(payment_proto, publish_manifest=True)
