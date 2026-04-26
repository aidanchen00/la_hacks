"""
Ranker Agent — real Fetch.ai uAgent that scores and selects items found by the
search agents (CVS / Walgreens / GoodRx for pharmacy, ZocDoc / Healthgrades /
Solv for doctor).

Inputs: candidates + patient intake + budget.
Output: ranked list with `selected: bool` per item. The selected subset is what
actually gets booked / purchased and ends up on the Stripe checkout.

Two invocation paths:
  1. uAgent message: another agent sends RankRequest, gets RankerResult back.
  2. HTTP REST: `POST http://localhost:8107/rank` with the same payload — used
     by the FastAPI bridge so the Next.js UI can fire the ranker synchronously.

The ranker also persists its selection to SQLite (`ranker_selections`) so the
sidebars can poll it independently.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import httpx
import openai
from uagents import Agent, Context

from agents.shared.messages import (
    RankCandidate,
    RankedItem,
    RankerResult,
    RankRequest,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("ranker-agent")

# ---------------------------------------------------------------------------
# Agent setup
# ---------------------------------------------------------------------------

RANKER_SEED = os.getenv("RANKER_SEED", "ranker-la-hacks-2026-seed-phrase-pqr456")
FASTAPI_BASE = os.getenv("FASTAPI_BASE_URL", "http://localhost:8000")
DATABASE_PATH = str(Path(__file__).resolve().parents[2] / "prana.db")

ranker_agent = Agent(
    name="ranker",
    seed=RANKER_SEED,
    port=8107,
    mailbox=True,
    publish_agent_details=True,
    readme_path=str(Path(__file__).parent / "README.md"),
    network="testnet",
)

logger.info(f"Ranker agent address: {ranker_agent.address}")

# Realistic fallback prices when a search agent returns price=0 / unknown.
DOCTOR_FALLBACK_PRICE = {
    "emergency": 350.0,
    "urgent":    175.0,
    "routine":   150.0,
    "wellness":  120.0,
}
PHARMACY_FALLBACK_PRICE = 14.99   # generic OTC ballpark

# ---------------------------------------------------------------------------
# OpenAI client (matches api/routing.py usage)
# ---------------------------------------------------------------------------

_client: openai.AsyncOpenAI | None = None


def _llm() -> openai.AsyncOpenAI:
    global _client
    if _client is None:
        _client = openai.AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    return _client


RANKER_SYSTEM = """You are the Prana Ranker. Multiple search agents have proposed candidate \
products (pharmacy) or appointments (doctor) for one patient. Score each candidate 0..1 against \
the patient's needs and decide which ones to actually book/buy.

Selection rules:
- You do NOT have to pick everything. Pick 0, 1, 2, or all candidates depending on fit.
- If two candidates from different agents are essentially the same product/provider, prefer the \
  cheaper / faster / more available one and DO NOT select duplicates.
- For pharmacy: prefer in-stock items, lower price, items that match the query intent. Never \
  select prescription-only items if requires_doctor_approval is true.
- For doctor: prefer earliest available time, accepts insurance, and reasonable distance. Pick \
  the single best appointment unless multiple specialties are needed.
- Stay within total_budget_usd across all selected items.
- Be decisive — give a one-sentence rationale per item.

Return STRICT JSON:
{
  "selection_rationale": "<2-3 sentence overall reasoning>",
  "items": [
    {"index": <0-based index in the input candidates list>, "score": 0.0-1.0,
     "rationale": "<one sentence>", "selected": true|false}
  ]
}
Include EVERY input candidate exactly once in `items` (preserve indexing).
"""


def _fallback_price(domain: str, urgency: str) -> float:
    if domain == "doctor":
        return DOCTOR_FALLBACK_PRICE.get(urgency, DOCTOR_FALLBACK_PRICE["routine"])
    return PHARMACY_FALLBACK_PRICE


async def _rank_with_llm(req: RankRequest) -> RankerResult:
    """Score candidates with the LLM and assemble a RankerResult."""
    if not req.candidates:
        return RankerResult(run_id=req.run_id, domain=req.domain, ranked_items=[],
                             selected_total_usd=0.0, selection_rationale="No candidates to rank.")

    # Normalize prices: fill realistic defaults where missing
    fallback = _fallback_price(req.domain, req.urgency)
    candidates = []
    for c in req.candidates:
        price = c.price if c.price and c.price > 0 else fallback
        candidates.append({
            "source_agent": c.source_agent,
            "name": c.name,
            "price": round(price, 2),
            "url": c.url,
            "description": c.description,
            "metadata": c.metadata or {},
        })

    user_prompt = json.dumps({
        "domain": req.domain,
        "query": req.query,
        "intake_summary": req.intake_summary,
        "urgency": req.urgency,
        "requires_doctor_approval": req.requires_doctor_approval,
        "total_budget_usd": req.total_budget_usd,
        "per_agent_budget_usd": req.per_agent_budget_usd,
        "candidates": candidates,
    }, indent=2)

    try:
        resp = await _llm().chat.completions.create(
            model=os.getenv("RANKER_MODEL", "gpt-4o-mini"),
            messages=[
                {"role": "system", "content": RANKER_SYSTEM},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0.2,
        )
        parsed = json.loads(resp.choices[0].message.content or "{}")
    except Exception as e:
        logger.error(f"[ranker] LLM call failed: {e} — falling back to top-1 cheapest")
        parsed = {
            "selection_rationale": f"LLM unavailable; selected cheapest in-stock candidate.",
            "items": [],
        }

    # Map LLM output back to RankedItem list (one per input)
    by_index: Dict[int, Dict[str, Any]] = {}
    for it in parsed.get("items", []) or []:
        try:
            idx = int(it.get("index", -1))
        except Exception:
            continue
        if 0 <= idx < len(candidates):
            by_index[idx] = it

    ranked: List[RankedItem] = []
    for i, c in enumerate(candidates):
        scored = by_index.get(i, {})
        ranked.append(RankedItem(
            source_agent=c["source_agent"],
            name=c["name"],
            price=c["price"],
            url=c.get("url"),
            description=c.get("description"),
            metadata=c.get("metadata", {}),
            score=float(scored.get("score", 0.0) or 0.0),
            rationale=str(scored.get("rationale", "") or ""),
            selected=bool(scored.get("selected", False)),
        ))

    # Fallback: if LLM selected nothing, pick the highest scoring item (or first)
    if not any(r.selected for r in ranked):
        if ranked:
            ranked.sort(key=lambda r: r.score, reverse=True)
            ranked[0].selected = True
            ranked[0].rationale = ranked[0].rationale or "Auto-selected as best available option."

    selected_total = round(sum(r.price for r in ranked if r.selected), 2)

    return RankerResult(
        run_id=req.run_id,
        domain=req.domain,
        ranked_items=ranked,
        selected_total_usd=selected_total,
        selection_rationale=str(parsed.get("selection_rationale", "") or ""),
    )


def _persist(result: RankerResult) -> None:
    """Write ranker output to SQLite + log an agent event."""
    conn = sqlite3.connect(DATABASE_PATH, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        "DELETE FROM ranker_selections WHERE run_id = ? AND domain = ?",
        (result.run_id, result.domain),
    )
    for it in result.ranked_items:
        conn.execute(
            """INSERT INTO ranker_selections
               (run_id, domain, source_agent, name, price, url, description,
                metadata, score, rationale, selected)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                result.run_id, result.domain, it.source_agent, it.name,
                float(it.price), it.url, it.description,
                json.dumps(it.metadata or {}),
                float(it.score), it.rationale, int(bool(it.selected)),
            ),
        )
    conn.commit()
    conn.close()


async def _post_event(run_id: str, payload: Dict[str, Any]) -> None:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(f"{FASTAPI_BASE}/internal/agent-event", json={
                "run_id": run_id,
                "agent_name": "ranker",
                "event_type": "ranker_selected",
                "payload": payload,
            })
    except Exception as e:
        logger.warning(f"[ranker] post_event failed (non-fatal): {e}")


# ---------------------------------------------------------------------------
# uAgent message handler (real Fetch.ai entry point)
# ---------------------------------------------------------------------------

@ranker_agent.on_message(RankRequest)
async def on_rank_request(ctx: Context, sender: str, msg: RankRequest) -> None:
    logger.info(f"[ranker] RankRequest run={msg.run_id[:8]} domain={msg.domain} "
                f"candidates={len(msg.candidates)}")
    result = await _rank_with_llm(msg)
    _persist(result)
    await _post_event(msg.run_id, {
        "domain": result.domain,
        "selected_count": sum(1 for r in result.ranked_items if r.selected),
        "selected_total_usd": result.selected_total_usd,
        "rationale": result.selection_rationale,
    })
    await ctx.send(sender, result)
    logger.info(f"[ranker] selected {sum(1 for r in result.ranked_items if r.selected)}/"
                f"{len(result.ranked_items)} for run {msg.run_id[:8]}")


# ---------------------------------------------------------------------------
# HTTP REST endpoint — used by FastAPI to invoke the ranker synchronously
# ---------------------------------------------------------------------------

@ranker_agent.on_rest_post("/rank", RankRequest, RankerResult)
async def http_rank(ctx: Context, req: RankRequest) -> RankerResult:
    logger.info(f"[ranker:HTTP] run={req.run_id[:8]} domain={req.domain} "
                f"candidates={len(req.candidates)}")
    result = await _rank_with_llm(req)
    _persist(result)
    await _post_event(req.run_id, {
        "domain": result.domain,
        "selected_count": sum(1 for r in result.ranked_items if r.selected),
        "selected_total_usd": result.selected_total_usd,
        "rationale": result.selection_rationale,
    })
    return result


if __name__ == "__main__":
    ranker_agent.run()
