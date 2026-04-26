"""
Appointment-search agent factory.

Each appointment agent (ZocDoc / Healthgrades / Solv):
  1. Receives `AppointmentSearchRequest` from prana
  2. Launches a BrowserUse session via FastAPI (`/budget/browser/start`)
  3. Polls until terminal, parses the structured JSON output
  4. Replies with `AppointmentResult` to the prana address that invoked it

This is a separate factory from `make_seller_agent` (pharmacy) on purpose:
appointments don't need the buyer/seller payment dance — the user pays Stripe
once at the end for the visit fee.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import httpx
from uagents import Agent, Context

from agents.shared.messages import AppointmentResult, AppointmentSearchRequest
from agents.shared.playwright_browser import extract_with_playwright

from urllib.parse import quote_plus

logger = logging.getLogger("appointment-agent")

FASTAPI_BASE = os.getenv("FASTAPI_BASE_URL", "http://localhost:8000")
BROWSER_POLL_INTERVAL = 5
BROWSER_TIMEOUT = 180  # 3 min — appointment search pages are slower than product search


def _build_task(platform: str, base_url: str, query: str, location: str) -> str:
    """Same prompt shape as web/src/app/api/browser/start/route.ts so the cloud
    sessions return identical structured JSON."""
    return "\n".join([
        f"You are a healthcare appointment search agent using {platform}.",
        f"1. Go to {base_url} and wait until the page is fully interactive.",
        f'2. Search for "{query}" doctors in "{location}". Use the search inputs and press Enter.',
        "3. WAIT for the search results page — scroll once if needed so providers are visible.",
        "4. Extract up to 5 providers with: provider (name), specialty, time (earliest available), "
        "address, listingUrl (absolute URL), acceptsInsurance (true/false/null).",
        "5. Do NOT stop until you've extracted at least one provider OR confirmed zero results. "
        "Retry the search once if the first attempt hits a captcha or empty page.",
        f'6. Return STRICT JSON: {{"source": "{platform}", "appointments": '
        '[{"provider": ..., "specialty": ..., "time": ..., "address": ..., '
        '"listingUrl": ..., "acceptsInsurance": ...}]}.',
        "IMPORTANT: Wellness care navigation only — no medical advice.",
    ])


def _parse_providers(raw_output: Any) -> List[Dict[str, Any]]:
    """Pull `appointments` out of the BrowserUse result, regardless of shape."""
    if raw_output is None or raw_output == "":
        return []
    text = raw_output if isinstance(raw_output, str) else json.dumps(raw_output)
    text = text.strip()
    # BrowserUse sometimes wraps JSON in markdown fences
    if "```" in text:
        for chunk in text.split("```"):
            chunk = chunk.strip()
            if chunk.startswith("json"):
                chunk = chunk[4:].strip()
            if chunk.startswith("{") or chunk.startswith("["):
                text = chunk
                break
    try:
        data = json.loads(text)
    except Exception:
        return []
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        appointments = data.get("appointments")
        if isinstance(appointments, list):
            return appointments
    return []


# ---------------------------------------------------------------------------
# Local Playwright scraping (replaces BrowserUse SaaS)
# ---------------------------------------------------------------------------

def _mock_providers(platform: str, query: str, location: str) -> List[Dict[str, Any]]:
    """Realistic fixture providers used when scraping fails. Keeps the demo
    from blanking on bot walls."""
    p = platform.lower()
    base_url = "https://www.healthgrades.com" if "healthgrade" in p else "https://www.solvhealth.com"
    return [
        {"provider": f"Dr. Sarah Chen, MD (mock)", "specialty": query.title(),
         "time": "Tomorrow 10:00 AM", "address": f"{location}",
         "listingUrl": base_url, "acceptsInsurance": True},
        {"provider": f"Dr. Michael Rivera, DO (mock)", "specialty": query.title(),
         "time": "Tomorrow 2:30 PM", "address": f"{location}",
         "listingUrl": base_url, "acceptsInsurance": True},
        {"provider": f"Dr. Priya Patel, MD (mock)", "specialty": query.title(),
         "time": "Wed 9:15 AM", "address": f"{location}",
         "listingUrl": base_url, "acceptsInsurance": False},
    ]


def _looks_like_provider(name: str) -> bool:
    """Filter out page chrome that matches our generic selectors. A real
    provider name is short-ish and doesn't contain meta phrases."""
    if not name or len(name) > 120:
        return False
    lo = name.lower()
    bad_signals = ("we found", "results for", "filter by", "sort by", "skip", "showing", "near you",
                   "search", "view all", "see more", "loading")
    return not any(b in lo for b in bad_signals)


async def _extract_healthgrades(page) -> Optional[Dict[str, Any]]:
    """Healthgrades search results: find provider cards. Best-effort selectors."""
    await page.wait_for_selector("a[href*='/physician/'], h3 a, .card", timeout=12_000)
    items = []
    cards = await page.query_selector_all("article, [data-qa-target*='provider'], li.card")
    for c in cards[:8]:
        name_el = await c.query_selector("a[href*='/physician/'] h3, a[href*='/physician/'] h2, h3, h2")
        if not name_el:
            continue
        name = (await name_el.inner_text()).strip()
        if not _looks_like_provider(name):
            continue
        href_el = await c.query_selector("a[href*='/physician/']") or await c.query_selector("a[href]")
        href = await href_el.get_attribute("href") if href_el else None
        if href and href.startswith("/"):
            href = "https://www.healthgrades.com" + href
        items.append({"provider": name[:120], "specialty": None, "time": None,
                       "address": None, "listingUrl": href, "acceptsInsurance": None})
        if len(items) >= 5:
            break
    if not items:
        return None
    return {"appointments": items}


async def _extract_solv(page) -> Optional[Dict[str, Any]]:
    """Solv: urgent care booking. Try generic provider/clinic card selectors."""
    await page.wait_for_selector("a[href*='/urgent-care'], h3, .clinic-card", timeout=12_000)
    items = []
    cards = await page.query_selector_all("a[href*='/urgent-care'], li, article")
    for c in cards[:8]:
        name_el = await c.query_selector("h3, h2, span")
        if not name_el:
            continue
        name = (await name_el.inner_text()).strip()
        if not _looks_like_provider(name):
            continue
        href = await c.get_attribute("href") if await c.evaluate("el => el.tagName") == "A" else None
        if href and href.startswith("/"):
            href = "https://www.solvhealth.com" + href
        items.append({"provider": name[:120], "specialty": None, "time": "Walk-in",
                       "address": None, "listingUrl": href, "acceptsInsurance": True})
        if len(items) >= 5:
            break
    if not items:
        return None
    return {"appointments": items}


_PLATFORM_HANDLERS = {
    "healthgrades": (
        lambda q, loc: f"https://www.healthgrades.com/usearch?what={quote_plus(q)}&where={quote_plus(loc)}",
        _extract_healthgrades,
    ),
    "solv": (
        lambda q, loc: f"https://www.solvhealth.com/search?location={quote_plus(loc)}&specialty={quote_plus(q)}",
        _extract_solv,
    ),
}


async def _browser_search(
    agent_name: str,
    platform: str,
    base_url: str,  # kept for backward-compat with callers
    run_id: str,
    query: str,
    location: str,
    agent_logger: logging.Logger,
) -> AppointmentResult:
    handler = _PLATFORM_HANDLERS.get(platform.lower())
    parsed: Optional[Dict[str, Any]] = None

    if handler:
        url_builder, extractor = handler
        url = url_builder(query, location)
        try:
            parsed = await extract_with_playwright(url, extractor, timeout=25)
        except Exception as e:
            agent_logger.warning(f"[{agent_name}] playwright extractor crashed: {e}")
            parsed = None

    providers: List[Dict[str, Any]]
    if parsed and isinstance(parsed.get("appointments"), list) and parsed["appointments"]:
        providers = parsed["appointments"]
        agent_logger.info(f"[{agent_name}] live (Playwright): {len(providers)} provider(s)")
    else:
        providers = _mock_providers(platform, query, location)
        agent_logger.info(f"[{agent_name}] mock fallback: {len(providers)} provider(s)")

    return AppointmentResult(run_id=run_id, agent_name=agent_name, platform=platform,
                              providers=providers)


def make_appointment_agent(
    name: str,
    port: int,
    seed: str,
    platform: str,
    base_url: str,
    readme_path: str | None = None,
) -> Agent:
    agent = Agent(
        name=name,
        seed=seed,
        port=port,
        mailbox=True,
        publish_agent_details=True,
        readme_path=readme_path,
        network="testnet",
    )
    agent_logger = logging.getLogger(f"appointment-{name}")

    @agent.on_message(AppointmentSearchRequest)
    async def on_search(ctx: Context, sender: str, msg: AppointmentSearchRequest) -> None:
        agent_logger.info(f"[{name}] AppointmentSearchRequest run={msg.run_id[:8]} "
                          f"query='{msg.query}' loc='{msg.location}'")
        result = await _browser_search(
            agent_name=name, platform=platform, base_url=base_url,
            run_id=msg.run_id, query=msg.query, location=msg.location,
            agent_logger=agent_logger,
        )
        # Reply to whoever asked (prana uses requester_address; fall back to sender)
        target = msg.requester_address or sender
        await ctx.send(target, result)
        agent_logger.info(f"[{name}] AppointmentResult sent → {target[:20]} "
                          f"({len(result.providers)} providers)")

    return agent
