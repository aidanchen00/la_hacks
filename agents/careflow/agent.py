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
)

logger.info(f"Prana agent address: {careflow.address}")

# In-memory store for ASI:One sender addresses
_pending_chat: Dict[str, str] = {}     # run_id → sender_address (routing phase)
_pharmacy_chat: Dict[str, str] = {}   # run_id → sender_address (waiting for shopping results)

# ---------------------------------------------------------------------------
# LLM routing (same logic as api/routing.py but runs in-agent)
# ---------------------------------------------------------------------------

ROUTING_SYSTEM = """You are the Prana Orchestrator. Given a wellness intake message, return a JSON routing decision.

PATHS: doctor | pharmacy | mental_health | alt_medicine | self_care
URGENCY: emergency | urgent | routine | wellness

Rules:
- emergency → call 911 disclaimer required
- requires_doctor_approval = true when pharmacy path and Rx medications may be involved
- Never diagnose; use "may indicate", "consider consulting"

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
  "disclaimers": ["Prana is a wellness education tool..."]
}"""


async def route_text(text: str) -> Dict[str, Any]:
    client = openai.AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    try:
        resp = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": ROUTING_SYSTEM},
                {"role": "user", "content": text},
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
            "disclaimers": ["{Prana} is a wellness education tool, not a medical diagnosis service."],
        }


# ---------------------------------------------------------------------------
# SQLite helpers (mirrors api/db.py but avoids circular import)
# ---------------------------------------------------------------------------

def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(DATABASE_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


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

    # Confirm receipt
    await ctx.send(sender, ChatMessage(
        timestamp=datetime.utcnow(), msg_id=uuid4(),
        content=[TextContent(type="text", text="Analyzing your wellness intake… Please wait a moment.")],
    ))

    run_id = str(uuid4())
    _create_run(run_id, text)
    _pending_chat[run_id] = sender

    decision = await route_text(text)
    decision["run_id"] = run_id
    _save_routing(run_id, decision)
    await _post_event(run_id, "routing_complete", decision)

    if decision.get("recommended_path") == "pharmacy":
        _pharmacy_chat[run_id] = sender  # keep sender alive until shopping results arrive
        await _trigger_budget(ctx, run_id, text, decision)

    result_text = (
        f"Prana Routing Decision (run: {run_id[:8]})\n\n"
        f"Urgency: {decision.get('urgency', 'wellness').upper()}\n"
        f"Recommended Path: {decision.get('recommended_path', 'self_care')}\n\n"
        f"{decision.get('summary', '')}\n\n"
        f"Next Actions:\n" + "\n".join(f"• {a}" for a in decision.get("next_actions", [])) + "\n\n"
        + "\n".join(decision.get("disclaimers", []))
    )

    await ctx.send(sender, ChatMessage(
        timestamp=datetime.utcnow(), msg_id=uuid4(),
        content=[
            TextContent(type="text", text=result_text),
            EndSessionContent(type="end-session"),
        ],
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
        f"Shopping Complete — {len(items)} products found across CVS, Walgreens, GoodRx & Amazon:\n"
    ]
    for item in items:
        status = "In Stock" if item.get("in_stock") else "Out of Stock"
        summary_lines.append(
            f"• {item.get('platform')}: {item.get('item') or 'No result'} "
            f"${item.get('price', 0):.2f} — {status}"
        )
    if checkout_url:
        summary_lines.append(f"\nCheckout: {checkout_url}")
        summary_lines.append("Pay with test card: 4242 4242 4242 4242 (any future date, any CVV)")
    else:
        summary_lines.append("\nNo items available for checkout.")

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


careflow.include(payment_proto, publish_manifest=True)
