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
from agents.shared.playwright_browser import extract_with_playwright

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
# Local Playwright scraping (replaces BrowserUse SaaS)
# ---------------------------------------------------------------------------
# Per-platform extractors. Each returns a dict matching the ShoppingResult
# JSON contract: {name, price, url, description, in_stock}. On any failure
# the extractor returns None (or the surrounding _scrape_or_mock falls back).

from urllib.parse import quote_plus


def _mock_for_platform(platform: str, query: str, budget: float) -> Dict[str, Any]:
    """Realistic-looking fixture used when live scraping fails. Keeps the
    demo from blanking on bot walls / captchas."""
    p = platform.lower()
    if p == "cvs":
        return {"name": f"CVS Health {query.title()} (mock)", "price": min(8.99, budget),
                "url": f"https://www.cvs.com/search?searchTerm={quote_plus(query)}",
                "description": "OTC · 30 ct", "in_stock": True}
    if p == "walgreens":
        return {"name": f"Walgreens {query.title()} Caplets (mock)", "price": min(11.49, budget),
                "url": f"https://www.walgreens.com/search/results.jsp?Ntt={quote_plus(query)}",
                "description": "OTC · 24 ct", "in_stock": True}
    if p == "goodrx":
        return {"name": f"Generic {query.title()} (mock)", "price": min(4.50, budget),
                "url": f"https://www.goodrx.com/search?query={quote_plus(query)}",
                "description": "Coupon price · ~$15 retail", "in_stock": True}
    if p == "amazon":
        return {"name": f"{query.title()} Pack of 2 (mock)", "price": min(13.99, budget),
                "url": f"https://www.amazon.com/s?k={quote_plus(query)}",
                "description": "Prime eligible · 60 ct total", "in_stock": True}
    return {"name": f"{platform} pick (mock)", "price": min(9.99, budget),
            "url": "", "description": "fallback", "in_stock": True}


async def _extract_goodrx(page) -> Optional[Dict[str, Any]]:
    """GoodRx: clean HTML, no login. Look for first drug card + its price."""
    await page.wait_for_selector("a[data-qa='med-link'], a[href*='/'], h2", timeout=12_000)
    name_el = await page.query_selector("a[data-qa='med-link'], h1, h2")
    name = (await name_el.inner_text()).strip() if name_el else None
    price_el = await page.query_selector("[data-qa='price'], span:has-text('$')")
    price_text = (await price_el.inner_text()).strip() if price_el else "0"
    url = page.url
    if not name:
        return None
    return {"name": name[:120], "price": price_text, "url": url, "description": "GoodRx coupon", "in_stock": True}


async def _extract_cvs(page) -> Optional[Dict[str, Any]]:
    """CVS often hits Akamai bot walls — best-effort first product card."""
    await page.wait_for_selector("[data-test='product-name'], .product-name, h2", timeout=12_000)
    name_el = await page.query_selector("[data-test='product-name'], .product-name, h2 a")
    name = (await name_el.inner_text()).strip() if name_el else None
    price_el = await page.query_selector("[data-test='price'], .price, span:has-text('$')")
    price_text = (await price_el.inner_text()).strip() if price_el else "0"
    if not name:
        return None
    return {"name": name[:120], "price": price_text, "url": page.url, "description": "CVS OTC", "in_stock": True}


async def _extract_walgreens(page) -> Optional[Dict[str, Any]]:
    """Walgreens: similar pattern to CVS, sometimes hits Challenge Validation."""
    await page.wait_for_selector(".product__title, h3 a, [data-tile-style] a", timeout=12_000)
    name_el = await page.query_selector(".product__title, h3 a, [data-tile-style] a")
    name = (await name_el.inner_text()).strip() if name_el else None
    price_el = await page.query_selector(".product__price, .price, span:has-text('$')")
    price_text = (await price_el.inner_text()).strip() if price_el else "0"
    if not name:
        return None
    return {"name": name[:120], "price": price_text, "url": page.url, "description": "Walgreens OTC", "in_stock": True}


_PLATFORM_HANDLERS = {
    "goodrx":    (lambda q: f"https://www.goodrx.com/search?query={quote_plus(q)}",  _extract_goodrx),
    "cvs":       (lambda q: f"https://www.cvs.com/search?searchTerm={quote_plus(q)}", _extract_cvs),
    "walgreens": (lambda q: f"https://www.walgreens.com/search/results.jsp?Ntt={quote_plus(q)}", _extract_walgreens),
    # Amazon: too aggressive on bots from headless chromium without proxies.
    # Always falls through to mock — keeping the agent in the lineup so
    # ranker still gets a 4-source spread.
}


async def _browser_search(
    agent_name: str,
    platform: str,
    task_template: str,  # kept for backward-compat with callers; ignored by Playwright path
    run_id: str,
    query: str,
    budget: float,
    agent_logger: logging.Logger,
) -> ShoppingResult:
    handler = _PLATFORM_HANDLERS.get(platform.lower())
    parsed: Optional[Dict[str, Any]] = None

    if handler:
        url_builder, extractor = handler
        url = url_builder(query)
        try:
            parsed = await extract_with_playwright(url, extractor, timeout=25)
        except Exception as e:
            agent_logger.warning(f"[{agent_name}] playwright extractor crashed: {e}")
            parsed = None

    if parsed and parsed.get("name"):
        agent_logger.info(f"[{agent_name}] live (Playwright): {parsed.get('name')[:60]}")
        return _build_result_from_dict(run_id, agent_name, platform, budget, parsed)

    mock = _mock_for_platform(platform, query, budget)
    agent_logger.info(f"[{agent_name}] mock fallback: {mock['name']}")
    return _build_result_from_dict(run_id, agent_name, platform, budget, mock)


def _build_result_from_dict(
    run_id: str, agent_name: str, platform: str, budget: float, data: Dict[str, Any]
) -> ShoppingResult:
    raw_price = data.get("price")
    if isinstance(raw_price, str):
        try:
            price = float(raw_price.replace("$", "").replace(",", "").split()[0])
        except (ValueError, IndexError):
            price = 0.0
    else:
        price = float(raw_price or 0)
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
        raw_price = data.get("price")
        if isinstance(raw_price, str):
            price = float(raw_price.replace("$", "").replace(",", "").strip() or 0)
        else:
            price = float(raw_price or 0)

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
