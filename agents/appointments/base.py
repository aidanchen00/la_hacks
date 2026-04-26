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


async def _browser_search(
    agent_name: str,
    platform: str,
    base_url: str,
    run_id: str,
    query: str,
    location: str,
    agent_logger: logging.Logger,
) -> AppointmentResult:
    task = _build_task(platform, base_url, query, location)

    session_id: Optional[str] = None
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(f"{FASTAPI_BASE}/budget/browser/start", json={
                "run_id": run_id,
                "agent_name": agent_name,
                "task": task,
            })
            session_id = resp.json().get("session_id")
    except Exception as e:
        agent_logger.error(f"[{agent_name}] BrowserUse start failed: {e}")
        return AppointmentResult(run_id=run_id, agent_name=agent_name, platform=platform,
                                  providers=[], error=str(e))

    if not session_id:
        return AppointmentResult(run_id=run_id, agent_name=agent_name, platform=platform,
                                  providers=[], error="No session_id from BrowserUse")

    agent_logger.info(f"[{agent_name}] BrowserUse session {session_id} started")

    elapsed = 0
    output: Any = None
    while elapsed < BROWSER_TIMEOUT:
        await asyncio.sleep(BROWSER_POLL_INTERVAL)
        elapsed += BROWSER_POLL_INTERVAL
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.get(
                    f"{FASTAPI_BASE}/budget/browser/status",
                    params={"session_id": session_id, "run_id": run_id, "agent_name": agent_name},
                )
                data = resp.json()
        except Exception as e:
            agent_logger.warning(f"[{agent_name}] Poll error (retrying): {e}")
            continue

        status = data.get("status", "")
        if status == "completed":
            output = data.get("output", "")
            break
        if status in ("failed", "error", "stopped"):
            return AppointmentResult(run_id=run_id, agent_name=agent_name, platform=platform,
                                      providers=[], error=data.get("error", status))

    if output is None:
        return AppointmentResult(run_id=run_id, agent_name=agent_name, platform=platform,
                                  providers=[], error="BrowserUse timeout")

    providers = _parse_providers(output)
    agent_logger.info(f"[{agent_name}] Parsed {len(providers)} provider(s)")
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
