"""
Prana FastAPI control plane.

Endpoints:
  POST /intake                — submit a voice intake → run_id
  GET  /runs/{id}             — full run status + routing decision
  GET  /runs/{id}/events      — SSE stream of agent events
  POST /internal/agent-event  — callback from uAgents
  POST /pay/checkout          — create Stripe checkout session
  POST /pay/webhook           — Stripe signed webhook
  GET  /health                — health check
"""
import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Any, AsyncGenerator, Dict, Optional
from uuid import uuid4

import httpx
import stripe
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from api.config import CORS_ORIGINS, STRIPE_SECRET_KEY

BROWSER_USE_API_KEY = os.getenv("BROWSER_USE_API_KEY", "")
BROWSER_USE_BASE    = "https://api.browser-use.com/api/v3"
# v3 BuModel enum: bu-mini | bu-max | bu-ultra | gemini-3-flash |
# claude-sonnet-4.6 | claude-opus-4.6 | gpt-5.4-mini.
# Default model (doctor + general): BYOK OpenAI for cost.
BROWSER_USE_MODEL          = os.getenv("BROWSER_USE_MODEL", "gpt-5.4-mini")
# Pharmacy override: shopping agents hit CVS/Walgreens/GoodRx/Amazon, which
# have heavier anti-bot. bu-max is BrowserUse's browser-tuned model — bills BU
# credits but actually gets through retailer challenges.
BROWSER_USE_PHARMACY_MODEL = os.getenv("BROWSER_USE_PHARMACY_MODEL", "bu-max")

# Shopping seller agents that hit pharmacy retailers — these get the
# BROWSER_USE_PHARMACY_MODEL override automatically.
_PHARMACY_SHOPPING_AGENTS = {"cvs", "walgreens", "goodrx", "amazon"}

# v3 lifecycle: created → idle → running → (stopped | timed_out | error).
# `idle` after a task ran means the task completed and the session is parked,
# so output-presence is the actual completion signal — not the status alone.
_BU_TERMINAL_STATUSES = {"stopped", "timed_out", "error"}

# active BrowserUse sessions for the budget pipeline: agent_name → session_id
_budget_browser_sessions: Dict[str, str] = {}
from api.db import (
    get_agent_events,
    get_routing_decision,
    get_run,
    init_db,
    insert_agent_event,
    insert_run,
    upsert_routing_decision,
    update_run_status,
    init_budget_session,
    update_budget_session,
    get_budget_session,
    get_all_wallets,
    get_cart_items,
    get_ranker_selections,
    mark_selections_booked,
)
from api.routing import route_intake

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("prana-api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Prana API starting up…")
    init_db()
    stripe.api_key = STRIPE_SECRET_KEY
    logger.info("Database initialized")
    yield
    logger.info("Prana API shutting down")


app = FastAPI(title="Prana API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {"ok": True, "service": "Prana API"}


# ---------------------------------------------------------------------------
# Intake → triggers async routing
# ---------------------------------------------------------------------------

@app.post("/intake")
async def intake(request: Request):
    body = await request.json()
    transcript = body.get("transcript", "")
    summary = body.get("summary", "")
    voice_session_id = body.get("voice_session_id", "")
    user_email = body.get("user_email", "")

    run_id = str(uuid4())
    insert_run(run_id, transcript, summary)
    logger.info(f"[intake] run {run_id[:8]} created")

    # Route asynchronously so we return the run_id immediately
    asyncio.create_task(_route_and_save(run_id, transcript, summary))

    return {"run_id": run_id}


async def _route_and_save(run_id: str, transcript: str, summary: str) -> None:
    try:
        decision = await route_intake(transcript, summary)
        decision["run_id"] = run_id
        upsert_routing_decision(decision)
        insert_agent_event(run_id, "orchestrator", "routing_complete", decision)
        logger.info(f"[route] run {run_id[:8]} → {decision.get('recommended_path')} ({decision.get('urgency')})")
    except Exception as e:
        logger.error(f"[route] run {run_id[:8]} routing failed: {e}")
        update_run_status(run_id, "error")


# ---------------------------------------------------------------------------
# Run status
# ---------------------------------------------------------------------------

@app.get("/runs/{run_id}")
async def get_run_status(run_id: str):
    run = get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    rd = get_routing_decision(run_id)
    events = get_agent_events(run_id)
    return {
        "id": run["id"],
        "status": run["status"],
        "intake_summary": run.get("intake_summary"),
        "routing_decision": rd,
        "events_count": len(events),
    }


# ---------------------------------------------------------------------------
# SSE event stream
# ---------------------------------------------------------------------------

@app.get("/runs/{run_id}/events")
async def stream_events(run_id: str):
    async def event_generator() -> AsyncGenerator[str, None]:
        seen = 0
        while True:
            events = get_agent_events(run_id, since=seen)
            for evt in events:
                payload = json.dumps(evt)
                yield f"data: {payload}\n\n"
                seen += 1
            await asyncio.sleep(1.5)

    return StreamingResponse(event_generator(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })


# ---------------------------------------------------------------------------
# Agent event callback (called by uAgents)
# ---------------------------------------------------------------------------

@app.post("/internal/agent-event")
async def agent_event(request: Request):
    body = await request.json()
    run_id = body.get("run_id", "")
    agent_name = body.get("agent_name", "unknown")
    event_type = body.get("event_type", "event")
    payload = body.get("payload", {})

    if run_id:
        insert_agent_event(run_id, agent_name, event_type, payload)
        if event_type == "routing_complete" and isinstance(payload, dict):
            payload["run_id"] = run_id
            upsert_routing_decision(payload)

    return {"ok": True}


# ---------------------------------------------------------------------------
# Stripe payment
# ---------------------------------------------------------------------------

@app.post("/pay/checkout")
async def create_checkout(request: Request):
    if not STRIPE_SECRET_KEY:
        raise HTTPException(status_code=500, detail="Stripe not configured")
    body = await request.json()
    run_id = body.get("run_id", "")
    amount_usd = float(body.get("amount", 5.0))
    item_name = body.get("item_name", "Prana Care Navigation")

    session = stripe.checkout.Session.create(
        mode="payment",
        payment_method_types=["card"],
        line_items=[{
            "price_data": {
                "currency": "usd",
                "product_data": {"name": item_name, "description": "Prana wellness care navigation service"},
                "unit_amount": int(amount_usd * 100),
            },
            "quantity": 1,
        }],
        success_url=f"http://localhost:3000/dashboard?run_id={run_id}&payment=success",
        cancel_url=f"http://localhost:3000/dashboard?run_id={run_id}&payment=cancel",
        metadata={"run_id": run_id},
    )
    return {"url": session.url, "session_id": session.id}


@app.post("/pay/webhook")
async def stripe_webhook(request: Request):
    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")
    webhook_secret = os.getenv("STRIPE_WEBHOOK_SECRET", "")

    try:
        if webhook_secret:
            event = stripe.Webhook.construct_event(payload, sig, webhook_secret)
        else:
            event = json.loads(payload)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    if event.get("type") == "checkout.session.completed":
        session_data = event["data"]["object"]
        run_id = (session_data.get("metadata") or {}).get("run_id", "")
        if run_id:
            insert_agent_event(run_id, "stripe", "payment_complete", {"stripe_session_id": session_data.get("id")})
            update_run_status(run_id, "paid")
            logger.info(f"[stripe] payment complete for run {run_id[:8]}")

    return {"received": True}


# ---------------------------------------------------------------------------
# Budget pipeline endpoints
# ---------------------------------------------------------------------------

@app.post("/budget/start")
async def budget_start(request: Request):
    """Called by budget agent to register a new budget session."""
    body = await request.json()
    run_id = body["run_id"]
    total_usd = float(body["total_budget_usd"])
    per_agent_usd = float(body["per_agent_usd"])
    num_agents = int(body.get("num_agents", 4))
    requester_address = body.get("requester_address", "")
    init_budget_session(run_id, total_usd, per_agent_usd, num_agents, requester_address)
    return {"ok": True, "run_id": run_id}


@app.get("/budget/{run_id}")
async def get_budget_status(run_id: str):
    session = get_budget_session(run_id)
    if not session:
        raise HTTPException(status_code=404, detail="Budget session not found")
    wallets = get_all_wallets(run_id)
    cart = get_cart_items(run_id)
    return {"session": session, "wallets": wallets, "cart": cart}


@app.post("/budget/checkout")
async def budget_checkout(request: Request):
    """Create a multi-item Stripe checkout session for all cart items."""
    if not STRIPE_SECRET_KEY:
        raise HTTPException(status_code=500, detail="Stripe not configured")
    body = await request.json()
    run_id = body.get("run_id", "")
    items: list = body.get("items", [])

    if not items:
        raise HTTPException(status_code=400, detail="No items to checkout")

    line_items = [
        {
            "price_data": {
                "currency": "usd",
                "product_data": {
                    "name": item.get("name", item.get("platform", "Product")),
                    "description": f"Found by {item.get('platform', 'shopping agent')}",
                },
                "unit_amount": max(1, int(float(item.get("price", 0)) * 100)),
            },
            "quantity": 1,
        }
        for item in items
    ]

    session = stripe.checkout.Session.create(
        mode="payment",
        payment_method_types=["card"],
        line_items=line_items,
        success_url=f"http://localhost:3000/pharmacy/{run_id}?payment=success",
        cancel_url=f"http://localhost:3000/pharmacy/{run_id}?payment=cancel",
        metadata={"run_id": run_id, "source": "budget_agent"},
    )

    update_budget_session(run_id, stripe_session_id=session.id, checkout_url=session.url,
                           status="checkout")
    selection_ids = [int(i["id"]) for i in items if isinstance(i.get("id"), int)]
    if selection_ids:
        mark_selections_booked(run_id, "pharmacy", selection_ids, session.id)
    insert_agent_event(run_id, "budget", "checkout_created",
                        {"stripe_session_id": session.id, "checkout_url": session.url,
                         "num_items": len(items)})

    logger.info(f"[budget] Stripe checkout created for run {run_id[:8]}: {session.url}")
    return {"checkout_url": session.url, "session_id": session.id}


# ---------------------------------------------------------------------------
# Budget BrowserUse session management
# ---------------------------------------------------------------------------

def _bu_output_to_str(output: Any) -> str:
    """v3 `output` is `unknown | null` — string when no outputSchema, otherwise
    a structured object. Shopping agents expect a string they can json.loads()."""
    if output is None:
        return ""
    if isinstance(output, str):
        return output
    try:
        return json.dumps(output)
    except Exception:
        return str(output)


@app.post("/budget/browser/start")
async def budget_browser_start(request: Request):
    """Start one BrowserUse v3 session and dispatch the seller-agent task.

    v3 contract:
      POST /sessions {task} → SessionResponse {id, status, liveUrl, ...}
    A new session is created and the task starts immediately when `task` is set
    and `sessionId` is omitted.
    """
    if not BROWSER_USE_API_KEY:
        raise HTTPException(status_code=500, detail="BROWSER_USE_API_KEY not configured")
    body = await request.json()
    run_id    = body["run_id"]
    agent_name = body["agent_name"]
    task      = body["task"]

    async with httpx.AsyncClient(timeout=20.0) as client:
        model = (
            BROWSER_USE_PHARMACY_MODEL
            if agent_name.lower() in _PHARMACY_SHOPPING_AGENTS
            else BROWSER_USE_MODEL
        )
        resp = await client.post(
            f"{BROWSER_USE_BASE}/sessions",
            headers={"X-Browser-Use-API-Key": BROWSER_USE_API_KEY},
            json={"task": task, "model": model},
        )
        if resp.status_code not in (200, 201):
            raise HTTPException(status_code=resp.status_code,
                                 detail=f"BrowserUse error: {resp.text}")
        data = resp.json()

    session_id = data.get("id")
    if not session_id:
        raise HTTPException(status_code=500, detail="No session id from BrowserUse v3")

    _budget_browser_sessions[agent_name] = session_id
    insert_agent_event(run_id, agent_name, "browser_started", {
        "session_id": session_id,
        "live_url": data.get("liveUrl"),
    })
    logger.info(f"[budget-browser] {agent_name} → session {session_id}")
    return {"session_id": session_id, "agent_name": agent_name, "live_url": data.get("liveUrl")}


@app.get("/budget/browser/status")
async def budget_browser_status(session_id: str, run_id: str = "", agent_name: str = ""):
    """Poll one BrowserUse v3 session.

    v3 statuses: created | idle | running | stopped | timed_out | error.
    `idle` after a task ran means the task completed and the session is parked,
    so output-presence is the actual completion signal.

    The shopping-agent caller (`agents/shopping/base.py`) expects this endpoint
    to return one of: completed | failed | running. Map v3 → that surface.
    """
    if not BROWSER_USE_API_KEY:
        raise HTTPException(status_code=500, detail="BROWSER_USE_API_KEY not configured")

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            f"{BROWSER_USE_BASE}/sessions/{session_id}",
            headers={"X-Browser-Use-API-Key": BROWSER_USE_API_KEY},
        )
        if resp.status_code == 404:
            return {"status": "error", "error": "session not found"}
        data = resp.json()

    bu_status = data.get("status", "running")
    output_str = _bu_output_to_str(data.get("output"))
    is_terminal = bu_status in _BU_TERMINAL_STATUSES
    has_output  = bool(output_str)

    if has_output or (bu_status == "idle" and data.get("isTaskSuccessful") is not None):
        if run_id and agent_name:
            insert_agent_event(run_id, agent_name, "browser_completed", {
                "session_id": session_id,
                "output_length": len(output_str),
                "bu_status": bu_status,
                "is_task_successful": data.get("isTaskSuccessful"),
            })
        return {"status": "completed", "output": output_str, "bu_status": bu_status}

    if is_terminal:
        return {
            "status": "failed",
            "error": f"BrowserUse session ended in {bu_status} with no output",
            "output": output_str,
            "bu_status": bu_status,
        }

    return {"status": "running", "output": output_str, "bu_status": bu_status}


@app.post("/budget/browser/stop-all")
async def budget_browser_stop_all():
    """Stop all active budget BrowserUse sessions.

    v3: POST /sessions/{id}/stop  (body optional — strategy defaults server-side).
    """
    if not BROWSER_USE_API_KEY or not _budget_browser_sessions:
        _budget_browser_sessions.clear()
        return {"stopped": 0}

    stopped = 0
    async with httpx.AsyncClient(timeout=10.0) as client:
        for agent_name, session_id in list(_budget_browser_sessions.items()):
            try:
                resp = await client.post(
                    f"{BROWSER_USE_BASE}/sessions/{session_id}/stop",
                    headers={"X-Browser-Use-API-Key": BROWSER_USE_API_KEY},
                    json={"strategy": "session"},
                )
                # Already-stopped sessions return 4xx — treat as no-op, not an error.
                if resp.status_code < 500:
                    stopped += 1
                    logger.info(f"[budget-browser] stopped session {session_id} ({agent_name})")
                else:
                    logger.warning(f"[budget-browser] stop {session_id} → {resp.status_code}: {resp.text}")
            except Exception as e:
                logger.warning(f"[budget-browser] stop {session_id} failed: {e}")

    _budget_browser_sessions.clear()
    return {"stopped": stopped}


# ---------------------------------------------------------------------------
# Ranker — proxy to ranker uAgent's REST endpoint, with inline fallback
# ---------------------------------------------------------------------------

RANKER_REST_URL = os.getenv("RANKER_REST_URL", "http://localhost:8107/rank")


@app.post("/rank/{run_id}")
async def run_ranker(run_id: str, request: Request):
    """Invoke the ranker uAgent. Body: { domain, query, candidates: [...], ... }."""
    body = await request.json()
    domain = body.get("domain", "pharmacy")
    payload = {
        "run_id": run_id,
        "domain": domain,
        "query": body.get("query", ""),
        "intake_summary": body.get("intake_summary", ""),
        "urgency": body.get("urgency", "wellness"),
        "requires_doctor_approval": bool(body.get("requires_doctor_approval", False)),
        "total_budget_usd": float(body.get("total_budget_usd", 0) or 0),
        "per_agent_budget_usd": float(body.get("per_agent_budget_usd", 0) or 0),
        "candidates": body.get("candidates", []) or [],
    }

    # Try the real uAgent REST endpoint first
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(RANKER_REST_URL, json=payload)
            if resp.status_code == 200:
                logger.info(f"[rank] uAgent ranked run {run_id[:8]} ({domain})")
                return resp.json()
            logger.warning(f"[rank] uAgent returned {resp.status_code}, falling back to inline")
    except Exception as e:
        logger.warning(f"[rank] uAgent unreachable ({e}), falling back to inline")

    # Inline fallback — same logic as the ranker uAgent (so the UI doesn't block
    # on the bureau being up). Selections are still persisted to the same table.
    from agents.ranker.agent import _rank_with_llm, _persist
    from agents.shared.messages import RankRequest, RankCandidate
    req = RankRequest(
        run_id=run_id,
        domain=payload["domain"],
        query=payload["query"],
        intake_summary=payload["intake_summary"],
        urgency=payload["urgency"],
        requires_doctor_approval=payload["requires_doctor_approval"],
        total_budget_usd=payload["total_budget_usd"],
        per_agent_budget_usd=payload["per_agent_budget_usd"],
        candidates=[RankCandidate(**c) for c in payload["candidates"]],
    )
    result = await _rank_with_llm(req)
    _persist(result)
    insert_agent_event(run_id, "ranker", "ranker_selected", {
        "domain": result.domain,
        "selected_count": sum(1 for r in result.ranked_items if r.selected),
        "selected_total_usd": result.selected_total_usd,
        "rationale": result.selection_rationale,
        "fallback": "inline",
    })
    return json.loads(result.json()) if hasattr(result, "json") else result.dict()


@app.get("/rank/{run_id}")
async def get_ranker(run_id: str, domain: Optional[str] = None):
    """Return persisted ranker selections (for the sidebar to poll)."""
    items = get_ranker_selections(run_id, domain)
    selected = [i for i in items if i["selected"]]
    return {
        "run_id": run_id,
        "domain": domain,
        "items": items,
        "selected": selected,
        "selected_total_usd": round(sum(i["price"] for i in selected), 2),
    }


# ---------------------------------------------------------------------------
# Doctor appointment Stripe checkout (fee for booking)
# ---------------------------------------------------------------------------

@app.post("/doctor/checkout")
async def doctor_checkout(request: Request):
    """Stripe checkout for a booked doctor appointment (uses ranker-selected items)."""
    if not STRIPE_SECRET_KEY:
        raise HTTPException(status_code=500, detail="Stripe not configured")
    body = await request.json()
    run_id = body.get("run_id", "")
    items: list = body.get("items", [])
    if not items:
        raise HTTPException(status_code=400, detail="No appointments to book")

    line_items = [
        {
            "price_data": {
                "currency": "usd",
                "product_data": {
                    "name": f"Appointment booking — {item.get('name', 'Provider')}",
                    "description": (item.get("description")
                                    or f"Booked via {item.get('source_agent', 'Prana')}")[:200],
                },
                "unit_amount": max(100, int(float(item.get("price", 150)) * 100)),
            },
            "quantity": 1,
        }
        for item in items
    ]

    session = stripe.checkout.Session.create(
        mode="payment",
        payment_method_types=["card"],
        line_items=line_items,
        success_url=f"http://localhost:3000/doctor/{run_id}?payment=success",
        cancel_url=f"http://localhost:3000/doctor/{run_id}?payment=cancel",
        metadata={"run_id": run_id, "source": "doctor_ranker"},
    )

    ids = [int(i["id"]) for i in items if i.get("id") is not None]
    if ids:
        mark_selections_booked(run_id, "doctor", ids, session.id)
    insert_agent_event(run_id, "ranker", "appointment_checkout_created",
                        {"stripe_session_id": session.id, "checkout_url": session.url,
                         "num_items": len(items)})
    logger.info(f"[doctor] Stripe checkout for run {run_id[:8]}: {session.url}")
    return {"checkout_url": session.url, "session_id": session.id}


@app.get("/runs")
async def list_runs():
    """Return recent runs with routing decisions for the sessions list."""
    from api.db import get_conn
    conn = get_conn()
    rows = conn.execute("""
        SELECT r.id, r.status, r.instruction, r.intake_summary, r.created_at,
               rd.urgency, rd.recommended_path, rd.summary AS rd_summary
        FROM runs r
        LEFT JOIN routing_decisions rd ON rd.run_id = r.id
        ORDER BY r.created_at DESC
        LIMIT 30
    """).fetchall()
    conn.close()
    return [dict(row) for row in rows]


@app.get("/")
async def root():
    return {"name": "Prana API", "version": "0.1.0", "docs": "/docs"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api.main:app", host="0.0.0.0", port=8000, reload=True)
