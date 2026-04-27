"""
Reddit agent — Agentverse-registered uAgent that wraps the Next.js
/api/composio/reddit route. Same pattern as sheets_agent.

Use case: prana orchestrator (or any future agent) can dispatch a
RedditPostRequest and discover the result asynchronously instead of making
a synchronous HTTP call to the front-end. Useful for "share this intake
to the community" automations.
"""
from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import httpx
from uagents import Agent, Context

from agents.shared.messages import RedditPostRequest, RedditPostResult

logger = logging.getLogger("reddit-agent")

NEXT_BASE = os.getenv("NEXT_BROWSER_BASE_URL") or os.getenv("NEXT_PUBLIC_NEXTJS_URL") or "http://localhost:3000"
PORT = int(os.getenv("REDDIT_AGENT_PORT", "8113"))
SEED = os.getenv("REDDIT_AGENT_SEED", "prana-reddit-la-hacks-2026-seed")

reddit_agent = Agent(
    name="reddit_agent",
    port=PORT,
    seed=SEED,
    mailbox=True,   # registers via Agentverse mailbox; do NOT set `endpoint`
                    # alongside it — uAgents picks endpoint and ignores mailbox.
)


@reddit_agent.on_event("startup")
async def _startup(ctx: Context) -> None:
    ctx.logger.info(f"reddit_agent ready at {reddit_agent.address}")


@reddit_agent.on_message(RedditPostRequest)
async def on_post(ctx: Context, sender: str, msg: RedditPostRequest) -> None:
    """Forward to Next.js /api/composio/reddit and reply with posted URL or error."""
    payload = {
        "subreddit": msg.subreddit,
        "title": msg.title,
        "text": msg.body,
        "kind": "self",
        "nsfw": msg.nsfw,
        "spoiler": msg.spoiler,
        "runId": msg.run_id,
    }
    try:
        async with httpx.AsyncClient(timeout=45.0) as client:
            r = await client.post(f"{NEXT_BASE}/api/composio/reddit", json=payload)
        data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}

        if data.get("redditNotConnected"):
            ctx.logger.warning(f"[reddit] run={msg.run_id[:8]} not connected")
            await ctx.send(sender, RedditPostResult(
                run_id=msg.run_id, posted=False,
                error="Reddit account not connected for this Composio entity",
                reddit_not_connected=True,
            ))
            return

        if r.status_code == 200 and data.get("posted"):
            ctx.logger.info(f"[reddit] run={msg.run_id[:8]} posted → {data.get('url')}")
            await ctx.send(sender, RedditPostResult(
                run_id=msg.run_id, posted=True, url=data.get("url"),
            ))
            return

        err = data.get("error") or f"HTTP {r.status_code}"
        ctx.logger.warning(f"[reddit] run={msg.run_id[:8]} failed: {err}")
        await ctx.send(sender, RedditPostResult(run_id=msg.run_id, posted=False, error=str(err)))
    except Exception as e:
        ctx.logger.error(f"[reddit] run={msg.run_id[:8]} threw: {e}")
        await ctx.send(sender, RedditPostResult(run_id=msg.run_id, posted=False, error=str(e)))


__all__ = ["reddit_agent"]
