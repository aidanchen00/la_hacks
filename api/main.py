"""
CareFlow FastAPI control plane.

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
BROWSER_USE_BASE    = "https://api.browser.use.com/v1"

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
)
from api.routing import route_intake

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("careflow-api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("CareFlow API starting up…")
    init_db()
    stripe.api_key = STRIPE_SECRET_KEY
    logger.info("Database initialized")
    yield
    logger.info("CareFlow API shutting down")


app = FastAPI(title="CareFlow API", version="0.1.0", lifespan=lifespan)

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
    return {"ok": True, "service": "CareFlow API"}


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
    item_name = body.get("item_name", "CareFlow Care Navigation")

    session = stripe.checkout.Session.create(
        mode="payment",
        payment_method_types=["card"],
        line_items=[{
            "price_data": {
                "currency": "usd",
                "product_data": {"name": item_name, "description": "CareFlow wellness care navigation service"},
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
    insert_agent_event(run_id, "budget", "checkout_created",
                        {"stripe_session_id": session.id, "checkout_url": session.url,
                         "num_items": len(items)})

    logger.info(f"[budget] Stripe checkout created for run {run_id[:8]}: {session.url}")
    return {"checkout_url": session.url, "session_id": session.id}


# ---------------------------------------------------------------------------
# Budget BrowserUse session management
# ---------------------------------------------------------------------------

@app.post("/budget/browser/start")
async def budget_browser_start(request: Request):
    """Start one BrowserUse session for a seller agent."""
    if not BROWSER_USE_API_KEY:
        raise HTTPException(status_code=500, detail="BROWSER_USE_API_KEY not configured")
    body = await request.json()
    run_id    = body["run_id"]
    agent_name = body["agent_name"]
    task      = body["task"]

    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.post(
            f"{BROWSER_USE_BASE}/run-task",
            headers={"Authorization": f"Bearer {BROWSER_USE_API_KEY}"},
            json={"task": task, "save_browser_data": False},
        )
        if resp.status_code not in (200, 201):
            raise HTTPException(status_code=resp.status_code,
                                 detail=f"BrowserUse error: {resp.text}")
        data = resp.json()

    session_id = data.get("id") or data.get("task_id") or data.get("session_id")
    if not session_id:
        raise HTTPException(status_code=500, detail="No session_id from BrowserUse")

    _budget_browser_sessions[agent_name] = session_id
    insert_agent_event(run_id, agent_name, "browser_started", {"session_id": session_id})
    logger.info(f"[budget-browser] {agent_name} → session {session_id}")
    return {"session_id": session_id, "agent_name": agent_name}


@app.get("/budget/browser/status")
async def budget_browser_status(session_id: str, run_id: str = "", agent_name: str = ""):
    """Poll one BrowserUse session for status and result."""
    if not BROWSER_USE_API_KEY:
        raise HTTPException(status_code=500, detail="BROWSER_USE_API_KEY not configured")

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            f"{BROWSER_USE_BASE}/task/{session_id}",
            headers={"Authorization": f"Bearer {BROWSER_USE_API_KEY}"},
        )
        if resp.status_code == 404:
            return {"status": "error", "error": "session not found"}
        data = resp.json()

    status = data.get("status", "running")
    output = data.get("output") or data.get("result") or ""

    if status in ("finished", "done", "completed", "success"):
        if run_id and agent_name:
            insert_agent_event(run_id, agent_name, "browser_completed",
                                {"session_id": session_id, "output_length": len(str(output))})
        return {"status": "completed", "output": output}
    elif status in ("failed", "error", "stopped", "cancelled"):
        return {"status": "failed", "error": data.get("error", status), "output": output}
    else:
        return {"status": "running", "output": output}


@app.post("/budget/browser/stop-all")
async def budget_browser_stop_all():
    """Stop all active budget BrowserUse sessions."""
    if not BROWSER_USE_API_KEY or not _budget_browser_sessions:
        _budget_browser_sessions.clear()
        return {"stopped": 0}

    stopped = 0
    async with httpx.AsyncClient(timeout=10.0) as client:
        for agent_name, session_id in list(_budget_browser_sessions.items()):
            try:
                await client.delete(
                    f"{BROWSER_USE_BASE}/task/{session_id}/stop",
                    headers={"Authorization": f"Bearer {BROWSER_USE_API_KEY}"},
                )
                stopped += 1
                logger.info(f"[budget-browser] stopped session {session_id} ({agent_name})")
            except Exception as e:
                logger.warning(f"[budget-browser] stop {session_id} failed: {e}")

    _budget_browser_sessions.clear()
    return {"stopped": stopped}


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
    return {"name": "CareFlow API", "version": "0.1.0", "docs": "/docs"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api.main:app", host="0.0.0.0", port=8000, reload=True)
