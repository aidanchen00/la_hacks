"""
Seller agent factory for shopping platform agents.

Each seller agent:
  1. Receives BudgetAllocation from budget agent
  2. Sends RequestPayment (seller role) back to budget agent
  3. On CommitPayment: sends CompletePayment, then launches BrowserUse search
  4. Polls /budget/browser/status until result or timeout
  5. Sends ShoppingResult back to budget agent
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any, Dict, Optional
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import httpx
from uagents import Agent, Context, Protocol

from uagents_core.contrib.protocols.payment import (  # type: ignore
    CommitPayment,
    CompletePayment,
    CancelPayment,
    RequestPayment,
    RejectPayment,
    Funds,
    payment_protocol_spec,
)

from agents.shared.messages import BudgetAllocation, ShoppingResult

logger = logging.getLogger("shopping-agent")

FASTAPI_BASE = os.getenv("FASTAPI_BASE_URL", "http://localhost:8000")
BROWSER_POLL_INTERVAL = 5   # seconds
BROWSER_TIMEOUT      = 120  # seconds

# In-memory state: txn_id → pending session info
_pending: Dict[str, Dict[str, Any]] = {}


def make_seller_agent(
    name: str,
    port: int,
    seed: str,
    platform: str,
    browser_task_template: str,
    readme_path: str | None = None,
) -> Agent:
    """
    Returns a configured uAgent that acts as a seller in the Payment Protocol.
    browser_task_template may contain {query} and {budget} placeholders.
    """
    agent = Agent(
        name=name,
        seed=seed,
        port=port,
        mailbox=True,
        publish_agent_details=True,
        readme_path=readme_path,
        network="testnet",
    )
    agent_logger = logging.getLogger(f"shopping-{name}")

    # -----------------------------------------------------------------
    # BudgetAllocation handler — kicks off the payment handshake
    # -----------------------------------------------------------------

    @agent.on_message(BudgetAllocation)
    async def on_budget_allocation(ctx: Context, sender: str, msg: BudgetAllocation) -> None:
        run_id = msg.run_id
        agent_logger.info(f"[{name}] BudgetAllocation run={run_id[:8]} ${msg.allocated_usd:.2f} "
                          f"for '{msg.query}'")

        reference = f"budget:{run_id}:{name}"

        # Store pending state keyed by reference (resolved to txn on CommitPayment)
        _pending[reference] = {
            "run_id": run_id,
            "query": msg.query,
            "allocated_usd": msg.allocated_usd,
            "budget_agent_address": sender,
        }

        request = RequestPayment(
            accepted_funds=[
                Funds(
                    currency="usd",
                    amount=str(msg.allocated_usd),
                    payment_method="stripe",
                )
            ],
            recipient=ctx.agent.address,
            deadline_seconds=120,
            reference=reference,
            description=f"{platform} shopping service — ${msg.allocated_usd:.2f} budget",
            metadata={"run_id": run_id, "platform": platform},
        )
        await ctx.send(sender, request)
        agent_logger.info(f"[{name}] RequestPayment sent to budget agent (${msg.allocated_usd:.2f})")

    # -----------------------------------------------------------------
    # Payment Protocol — seller role
    # -----------------------------------------------------------------

    payment_proto = Protocol(spec=payment_protocol_spec, role="seller")

    @payment_proto.on_message(CommitPayment)
    async def on_commit(ctx: Context, sender: str, msg: CommitPayment) -> None:
        ref = msg.reference or ""
        state = _pending.pop(ref, None)
        if not state:
            agent_logger.warning(f"[{name}] CommitPayment for unknown ref: {ref}")
            return

        txn_id = msg.transaction_id
        run_id = state["run_id"]
        query = state["query"]
        allocated = state["allocated_usd"]
        budget_address = state["budget_agent_address"]

        agent_logger.info(f"[{name}] CommitPayment received — wallet funded txn={txn_id}")

        # Acknowledge payment complete
        await ctx.send(sender, CompletePayment(transaction_id=txn_id))

        # Now search within our budget
        result = await _browser_search(name, platform, browser_task_template,
                                        run_id, query, allocated, agent_logger)

        await ctx.send(budget_address, result)
        agent_logger.info(f"[{name}] ShoppingResult sent: {result.item_name} ${result.item_price:.2f}")

    @payment_proto.on_message(RejectPayment)
    async def on_reject(ctx: Context, sender: str, msg: RejectPayment) -> None:
        agent_logger.warning(f"[{name}] RejectPayment: {getattr(msg, 'reason', '')}")

    agent.include(payment_proto, publish_manifest=True)

    return agent


# ---------------------------------------------------------------------------
# BrowserUse search helper
# ---------------------------------------------------------------------------

async def _browser_search(
    agent_name: str,
    platform: str,
    task_template: str,
    run_id: str,
    query: str,
    budget: float,
    agent_logger: logging.Logger,
) -> ShoppingResult:
    task = task_template.format(query=query, budget=budget)

    # Start BrowserUse session
    session_id: Optional[str] = None
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(f"{FASTAPI_BASE}/budget/browser/start", json={
                "run_id": run_id,
                "agent_name": agent_name,
                "task": task,
            })
            data = resp.json()
            session_id = data.get("session_id")
    except Exception as e:
        agent_logger.error(f"[{agent_name}] BrowserUse start failed: {e}")
        return _error_result(run_id, agent_name, platform, budget, str(e))

    if not session_id:
        return _error_result(run_id, agent_name, platform, budget, "No session_id returned")

    agent_logger.info(f"[{agent_name}] BrowserUse session started: {session_id}")

    # Poll for result
    elapsed = 0
    while elapsed < BROWSER_TIMEOUT:
        await asyncio.sleep(BROWSER_POLL_INTERVAL)
        elapsed += BROWSER_POLL_INTERVAL

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    f"{FASTAPI_BASE}/budget/browser/status",
                    params={"session_id": session_id, "run_id": run_id, "agent_name": agent_name},
                )
                data = resp.json()
        except Exception as e:
            agent_logger.warning(f"[{agent_name}] Poll error (retrying): {e}")
            continue

        status = data.get("status", "")
        agent_logger.info(f"[{agent_name}] Browser status: {status} ({elapsed}s)")

        if status == "completed":
            return _parse_result(run_id, agent_name, platform, budget, data.get("output", ""))
        elif status in ("failed", "stopped", "error"):
            return _error_result(run_id, agent_name, platform, budget,
                                  data.get("error", f"Browser session {status}"))

    return _error_result(run_id, agent_name, platform, budget, "BrowserUse timeout (120s)")


def _parse_result(
    run_id: str,
    agent_name: str,
    platform: str,
    budget: float,
    raw_output: str,
) -> ShoppingResult:
    """Parse JSON output from BrowserUse agent."""
    try:
        # BrowserUse may return JSON embedded in markdown
        text = raw_output.strip()
        if "```" in text:
            parts = text.split("```")
            for part in parts:
                part = part.strip()
                if part.startswith("json"):
                    part = part[4:].strip()
                if part.startswith("{"):
                    text = part
                    break

        data: Dict[str, Any] = json.loads(text)
        price = float(data.get("price", 0) or 0)
        # Strip "$" if present
        if isinstance(data.get("price"), str):
            price = float(data["price"].replace("$", "").replace(",", "").strip() or 0)

        spent = min(price, budget)
        return ShoppingResult(
            run_id=run_id,
            agent_name=agent_name,
            platform=platform,
            item_name=data.get("name") or data.get("title"),
            item_price=price,
            item_url=data.get("url") or data.get("link"),
            item_description=data.get("description"),
            in_stock=bool(data.get("in_stock", True)),
            wallet_spent=spent,
            wallet_remaining=round(budget - spent, 2),
        )
    except Exception as e:
        logger.warning(f"[{agent_name}] Failed to parse browser output: {e}. Raw: {raw_output[:200]}")
        return _error_result(run_id, agent_name, platform, budget, f"Parse error: {e}")


def _error_result(run_id: str, agent_name: str, platform: str,
                   budget: float, error: str) -> ShoppingResult:
    return ShoppingResult(
        run_id=run_id,
        agent_name=agent_name,
        platform=platform,
        item_name=None,
        item_price=0.0,
        in_stock=False,
        wallet_spent=0.0,
        wallet_remaining=budget,
        error=error,
    )
