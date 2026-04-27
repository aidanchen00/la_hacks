"""
Sheets agent — Agentverse-registered uAgent that wraps the Next.js
/api/composio/sheets route. Lets other agents in the bureau append rows to
the configured Google Sheet via a clean Fetch.ai message instead of an
ad-hoc httpx call.

Implementation: thin proxy. The actual Composio SDK call happens in the
Next.js route (which already has the connected account + auth_config
plumbing). This agent's job is to be discoverable on Agentverse and
forward structured requests to it.
"""
from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import httpx
from uagents import Agent, Context

from agents.shared.messages import SheetsAppendRequest, SheetsAppendResult

logger = logging.getLogger("sheets-agent")

NEXT_BASE = os.getenv("NEXT_BROWSER_BASE_URL") or os.getenv("NEXT_PUBLIC_NEXTJS_URL") or "http://localhost:3000"
PORT = int(os.getenv("SHEETS_AGENT_PORT", "8112"))
SEED = os.getenv("SHEETS_AGENT_SEED", "prana-sheets-la-hacks-2026-seed")

sheets_agent = Agent(
    name="sheets_agent",
    port=PORT,
    seed=SEED,
    mailbox=True,   # registers via Agentverse mailbox; do NOT set `endpoint`
                    # alongside it — uAgents picks endpoint and ignores mailbox.
)


@sheets_agent.on_event("startup")
async def _startup(ctx: Context) -> None:
    ctx.logger.info(f"sheets_agent ready at {sheets_agent.address}")


@sheets_agent.on_message(SheetsAppendRequest)
async def on_append(ctx: Context, sender: str, msg: SheetsAppendRequest) -> None:
    """Forward to Next.js /api/composio/sheets and reply with the outcome."""
    payload = {
        "run_id": msg.run_id,
        "timestamp": msg.timestamp,
        "user_email": msg.user_email,
        "summary": msg.summary,
        "symptoms": msg.symptoms,
        "urgency": msg.urgency,
        "recommended_path": msg.recommended_path,
        "next_actions": msg.next_actions,
        "disclaimers": msg.disclaimers,
    }
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(f"{NEXT_BASE}/api/composio/sheets", json=payload)
        data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        if r.status_code == 200 and data.get("saved"):
            ctx.logger.info(f"[sheets] run={msg.run_id[:8]} appended ✓")
            await ctx.send(sender, SheetsAppendResult(run_id=msg.run_id, saved=True))
            return
        err = data.get("error") or f"HTTP {r.status_code}"
        ctx.logger.warning(f"[sheets] run={msg.run_id[:8]} append failed: {err}")
        await ctx.send(sender, SheetsAppendResult(run_id=msg.run_id, saved=False, error=str(err)))
    except Exception as e:
        ctx.logger.error(f"[sheets] run={msg.run_id[:8]} threw: {e}")
        await ctx.send(sender, SheetsAppendResult(run_id=msg.run_id, saved=False, error=str(e)))


# Re-exported so run_all.py can import & register
__all__ = ["sheets_agent"]
