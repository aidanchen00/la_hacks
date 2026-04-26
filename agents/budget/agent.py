"""
Budget Agent — buyer side of the uAgents Payment Protocol.

Flow per run:
  1. Receive BudgetRequest from prana orchestrator
  2. Stop all active BrowserUse sessions (clean slate)
  3. Split budget equally across CVS, Walgreens, GoodRx, Amazon
  4. Send BudgetAllocation to each seller agent → they request payment
  5. Handle RequestPayment → CommitPayment for each seller
  6. Handle CompletePayment → mark wallet funded
  7. Collect ShoppingResult from each seller (batched: CVS/Walgreens/GoodRx first, then Amazon)
  8. POST /budget/checkout → Stripe multi-item session
  9. Relay checkout URL back to prana for ASI:One delivery
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
from typing import Any, Dict, List, Optional
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import httpx
from uagents import Agent, Context, Protocol

from uagents_core.contrib.protocols.payment import (  # type: ignore
    CommitPayment,
    CompletePayment,
    CancelPayment,
    RequestPayment,
    Funds,
    payment_protocol_spec,
)

from agents.shared.messages import BudgetAllocation, BudgetRequest, ShoppingResult

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("budget-agent")

# ---------------------------------------------------------------------------
# Agent setup
# ---------------------------------------------------------------------------

BUDGET_SEED = os.getenv("BUDGET_SEED", "budget-la-hacks-2026-seed-phrase-xyz789")
FASTAPI_BASE = os.getenv("FASTAPI_BASE_URL", "http://localhost:8000")

budget_agent = Agent(
    name="budget",
    seed=BUDGET_SEED,
    port=8102,
    mailbox=True,
    publish_agent_details=True,
    readme_path=str(Path(__file__).parent / "README.md"),
    network="testnet",
)

logger.info(f"Budget agent address: {budget_agent.address}")

# Seller agent addresses — resolved at runtime via environment or hardcoded seeds
CVS_SEED     = "cvs-seller-seed-la-hacks-2026"
WALGREENS_SEED = "walgreens-seller-seed-la-hacks-2026"
GOODRX_SEED  = "goodrx-seller-seed-la-hacks-2026"
AMAZON_SEED  = "amazon-seller-seed-la-hacks-2026"

def _seed_to_address(seed: str) -> str:
    """Derive agent address from seed (same as Agent(seed=...).address)."""
    from uagents.crypto import Identity
    return Identity.from_seed(seed, 0).address

CVS_ADDRESS      = _seed_to_address(CVS_SEED)
WALGREENS_ADDRESS = _seed_to_address(WALGREENS_SEED)
GOODRX_ADDRESS   = _seed_to_address(GOODRX_SEED)
AMAZON_ADDRESS   = _seed_to_address(AMAZON_SEED)

BATCH1_AGENTS = {
    "cvs":      CVS_ADDRESS,
    "walgreens": WALGREENS_ADDRESS,
    "goodrx":   GOODRX_ADDRESS,
}
BATCH2_AGENTS = {
    "amazon": AMAZON_ADDRESS,
}
ALL_AGENTS = {**BATCH1_AGENTS, **BATCH2_AGENTS}

# In-memory session state: run_id → session data
_sessions: Dict[str, Dict[str, Any]] = {}

# ---------------------------------------------------------------------------
# SQLite helpers
# ---------------------------------------------------------------------------

DATABASE_PATH = str(Path(__file__).resolve().parents[2] / "prana.db")


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(DATABASE_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def _init_budget_session(run_id: str, total_usd: float, per_agent_usd: float,
                          num_agents: int, requester_address: str) -> None:
    conn = _db()
    conn.execute(
        """INSERT OR IGNORE INTO budget_sessions
           (run_id, total_budget_usd, per_agent_usd, num_agents, requester_address)
           VALUES (?, ?, ?, ?, ?)""",
        (run_id, total_usd, per_agent_usd, num_agents, requester_address),
    )
    conn.commit()
    conn.close()


def _update_budget_session(run_id: str, **kwargs) -> None:
    allowed = {"status", "agents_done", "stripe_session_id", "checkout_url"}
    sets = ", ".join(f"{k} = ?" for k in kwargs if k in allowed)
    vals = [v for k, v in kwargs.items() if k in allowed]
    if not sets:
        return
    conn = _db()
    conn.execute(
        f"UPDATE budget_sessions SET {sets}, updated_at = datetime('now') WHERE run_id = ?",
        (*vals, run_id),
    )
    conn.commit()
    conn.close()


def _init_wallet(run_id: str, agent_name: str, allocated_usd: float) -> None:
    conn = _db()
    conn.execute(
        """INSERT OR IGNORE INTO agent_wallets (run_id, agent_name, allocated_usd, balance_usd)
           VALUES (?, ?, ?, ?)""",
        (run_id, agent_name, allocated_usd, allocated_usd),
    )
    conn.commit()
    conn.close()


def _fund_wallet(run_id: str, agent_name: str) -> None:
    conn = _db()
    conn.execute(
        """UPDATE agent_wallets SET status = 'funded', funded_at = datetime('now'),
           updated_at = datetime('now') WHERE run_id = ? AND agent_name = ?""",
        (run_id, agent_name),
    )
    conn.commit()
    conn.close()


def _insert_cart_item(run_id: str, result: ShoppingResult) -> None:
    conn = _db()
    conn.execute(
        """INSERT INTO shopping_cart
           (run_id, agent_name, platform, item_name, item_price, item_url, item_description, in_stock)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (run_id, result.agent_name, result.platform, result.item_name,
         result.item_price, result.item_url, result.item_description,
         int(result.in_stock)),
    )
    conn.execute(
        """UPDATE agent_wallets SET spent_usd = ?, balance_usd = ?,
           status = 'done', updated_at = datetime('now')
           WHERE run_id = ? AND agent_name = ?""",
        (result.wallet_spent, result.wallet_remaining, run_id, result.agent_name),
    )
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

async def _stop_all_browser_sessions() -> None:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(f"{FASTAPI_BASE}/budget/browser/stop-all")
        logger.info("[budget] Stopped all active BrowserUse sessions")
    except Exception as e:
        logger.warning(f"[budget] stop-all failed (non-fatal): {e}")


async def _create_checkout(run_id: str, items: List[Dict[str, Any]]) -> Optional[str]:
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(f"{FASTAPI_BASE}/budget/checkout", json={
                "run_id": run_id,
                "items": items,
            })
            data = resp.json()
            return data.get("checkout_url") or data.get("url")
    except Exception as e:
        logger.error(f"[budget] checkout creation failed: {e}")
        return None


async def _post_event(run_id: str, event_type: str, payload: Dict[str, Any]) -> None:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(f"{FASTAPI_BASE}/internal/agent-event", json={
                "run_id": run_id,
                "agent_name": "budget",
                "event_type": event_type,
                "payload": payload,
            })
    except Exception as e:
        logger.warning(f"[budget] post_event failed: {e}")


# ---------------------------------------------------------------------------
# Budget request handler (entry point from prana)
# ---------------------------------------------------------------------------

@budget_agent.on_message(BudgetRequest)
async def handle_budget_request(ctx: Context, sender: str, msg: BudgetRequest) -> None:
    run_id = msg.run_id
    total = msg.total_budget_usd
    num_agents = len(ALL_AGENTS)
    per_agent = round(total / num_agents, 2)

    logger.info(f"[budget] run {run_id[:8]}: total=${total:.2f}, per_agent=${per_agent:.2f}")

    # Clean up any leftover BrowserUse sessions from previous runs
    await _stop_all_browser_sessions()

    # Persist budget session
    _init_budget_session(run_id, total, per_agent, num_agents, sender)

    # Track in memory
    _sessions[run_id] = {
        "query": msg.query,
        "per_agent": per_agent,
        "total": total,
        "requester_address": sender,
        "batch1_pending": set(BATCH1_AGENTS.keys()),
        "batch2_pending": set(BATCH2_AGENTS.keys()),
        "batch1_done": False,
        "results": [],
        "commit_map": {},  # transaction_id → (run_id, agent_name)
    }

    # Initialise wallets in DB
    for agent_name in ALL_AGENTS:
        _init_wallet(run_id, agent_name, per_agent)

    await _post_event(run_id, "budget_allocated", {
        "total_usd": total, "per_agent_usd": per_agent, "agents": list(ALL_AGENTS.keys()),
    })

    # Send batch 1 allocations (CVS, Walgreens, GoodRx — 3 concurrent BrowserUse slots)
    for agent_name, address in BATCH1_AGENTS.items():
        alloc = BudgetAllocation(
            run_id=run_id,
            query=msg.query,
            allocated_usd=per_agent,
            total_budget_usd=total,
            budget_agent_address=ctx.agent.address,
        )
        await ctx.send(address, alloc)
        logger.info(f"[budget] Sent BudgetAllocation to {agent_name} (${per_agent:.2f})")

    _update_budget_session(run_id, status="shopping")


# ---------------------------------------------------------------------------
# Payment Protocol — buyer role
# ---------------------------------------------------------------------------

payment_proto = Protocol(spec=payment_protocol_spec, role="buyer")


@payment_proto.on_message(RequestPayment)
async def on_request_payment(ctx: Context, sender: str, msg: RequestPayment) -> None:
    ref = msg.reference or ""
    # reference format: "budget:{run_id}:{agent_name}"
    parts = ref.split(":")
    if len(parts) != 3 or parts[0] != "budget":
        logger.warning(f"[budget] Unexpected RequestPayment reference: {ref}")
        return

    run_id, agent_name = parts[1], parts[2]
    session = _sessions.get(run_id)
    if not session:
        logger.warning(f"[budget] No session for run {run_id[:8]}")
        return

    if not msg.accepted_funds:
        logger.warning(f"[budget] {agent_name} sent RequestPayment with no accepted_funds")
        return

    fund = msg.accepted_funds[0]
    txn_id = f"wallet-{run_id[:8]}-{agent_name}"

    # Track txn → (run_id, agent_name) for CompletePayment lookup
    session["commit_map"][txn_id] = (run_id, agent_name)

    commit = CommitPayment(
        funds=Funds(
            currency=fund.currency,
            amount=fund.amount,
            payment_method=fund.payment_method,
        ),
        recipient=msg.recipient,
        transaction_id=txn_id,
        reference=ref,
        description=f"Budget allocation for {agent_name} — run {run_id[:8]}",
        metadata={"run_id": run_id, "agent": agent_name},
    )
    await ctx.send(sender, commit)
    logger.info(f"[budget] CommitPayment → {agent_name} (txn={txn_id})")


@payment_proto.on_message(CompletePayment)
async def on_complete_payment(ctx: Context, sender: str, msg: CompletePayment) -> None:
    txn_id = msg.transaction_id or ""
    # Find session from txn_id
    for run_id, session in _sessions.items():
        if txn_id in session.get("commit_map", {}):
            _, agent_name = session["commit_map"][txn_id]
            _fund_wallet(run_id, agent_name)
            logger.info(f"[budget] Wallet funded: {agent_name} run={run_id[:8]}")
            await _post_event(run_id, "wallet_funded", {"agent": agent_name, "txn_id": txn_id})
            return
    logger.warning(f"[budget] CompletePayment for unknown txn {txn_id}")


@payment_proto.on_message(CancelPayment)
async def on_cancel_payment(ctx: Context, sender: str, msg: CancelPayment) -> None:
    logger.warning(f"[budget] CancelPayment from {sender[:20]}: {getattr(msg, 'reason', '')}")


budget_agent.include(payment_proto, publish_manifest=True)


# ---------------------------------------------------------------------------
# Shopping results collection
# ---------------------------------------------------------------------------

@budget_agent.on_message(ShoppingResult)
async def handle_shopping_result(ctx: Context, sender: str, msg: ShoppingResult) -> None:
    run_id = msg.run_id
    session = _sessions.get(run_id)
    if not session:
        logger.warning(f"[budget] ShoppingResult for unknown run {run_id[:8]}")
        return

    logger.info(f"[budget] Result from {msg.agent_name}: {msg.item_name} ${msg.item_price:.2f} "
                f"{'(in stock)' if msg.in_stock else '(OOS)'}")

    _insert_cart_item(run_id, msg)
    session["results"].append(msg)

    await _post_event(run_id, "shopping_result", {
        "agent": msg.agent_name,
        "platform": msg.platform,
        "item": msg.item_name,
        "price": msg.item_price,
        "in_stock": msg.in_stock,
        "error": msg.error,
    })

    # Remove from pending sets
    session["batch1_pending"].discard(msg.agent_name)
    session["batch2_pending"].discard(msg.agent_name)

    # When batch 1 finishes, stop those sessions and start Amazon
    if not session["batch1_pending"] and not session["batch1_done"]:
        session["batch1_done"] = True
        await _stop_all_browser_sessions()
        logger.info(f"[budget] Batch 1 complete for run {run_id[:8]}, starting Amazon")
        alloc = BudgetAllocation(
            run_id=run_id,
            query=session["query"],
            allocated_usd=session["per_agent"],
            total_budget_usd=session["total"],
            budget_agent_address=ctx.agent.address,
        )
        await ctx.send(AMAZON_ADDRESS, alloc)

    # When all 4 agents done → create Stripe checkout
    if not session["batch1_pending"] and not session["batch2_pending"]:
        await _finalize_run(ctx, run_id, session)


async def _finalize_run(ctx: Context, run_id: str, session: Dict[str, Any]) -> None:
    results: List[ShoppingResult] = session["results"]
    items = [
        {"name": r.item_name or r.platform, "price": r.item_price, "platform": r.platform}
        for r in results if r.in_stock and r.item_price > 0
    ]

    logger.info(f"[budget] Finalizing run {run_id[:8]} with {len(items)} purchasable items")

    checkout_url = await _create_checkout(run_id, items) if items else None

    if checkout_url:
        _update_budget_session(run_id, status="checkout", checkout_url=checkout_url)
        await _post_event(run_id, "checkout_ready", {"checkout_url": checkout_url, "items": items})
        logger.info(f"[budget] Checkout URL: {checkout_url}")
    else:
        _update_budget_session(run_id, status="complete")
        await _post_event(run_id, "shopping_complete", {"items": items, "checkout_url": None})

    # Relay back to prana orchestrator for ASI:One delivery
    requester = session.get("requester_address")
    if requester:
        from agents.shared.messages import SpecialistResult
        result_msg = SpecialistResult(
            run_id=run_id,
            path="pharmacy",
            success=True,
            artifacts={
                "items": [
                    {
                        "agent": r.agent_name,
                        "platform": r.platform,
                        "item": r.item_name,
                        "price": r.item_price,
                        "url": r.item_url,
                        "in_stock": r.in_stock,
                    }
                    for r in results
                ],
                "checkout_url": checkout_url,
                "total_items": len(items),
            },
        )
        await ctx.send(requester, result_msg)

    _sessions.pop(run_id, None)
