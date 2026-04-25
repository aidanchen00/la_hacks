"""
Local browser automation backend.

Stack:
- Steel Browser (https://github.com/steel-dev/steel-browser) — self-hosted Chromium
  in a Docker container. Provides remote CDP, hosted live-viewer URLs, and
  session lifecycle endpoints that match the BrowserUse cloud SDK shape.
- browser-use (https://github.com/browser-use/browser-use) — open-source Python
  framework that drives a browser via CDP using an LLM you control.

Replaces the BrowserUse cloud SDK (`browser-use-sdk/v3`) used in
`web/src/app/api/browser/start/route.ts`. The `liveUrl` returned by Steel is the
same shape (an iframe-embeddable URL), so the pharmacy/doctor pages keep
working unchanged.

Endpoints (mounted at /browser-local in api/main.py):
  POST /browser-local/start  — create N Steel sessions and kick off browser-use Agents
  POST /browser-local/status — poll status + extract structured output
  POST /browser-local/stop   — release sessions
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger("browser-local")

# ---------------------------------------------------------------------------
# Steel Browser configuration
# ---------------------------------------------------------------------------

STEEL_BASE_URL = os.getenv("STEEL_BASE_URL", "http://localhost:3000")
STEEL_API_KEY  = os.getenv("STEEL_API_KEY", "")  # optional — Steel can run without auth in dev
BROWSER_USE_LLM_MODEL = os.getenv("BROWSER_USE_LLM_MODEL", "gpt-4o-mini")
BROWSER_USE_LLM_PROVIDER = os.getenv("BROWSER_USE_LLM_PROVIDER", "openai")  # openai | anthropic | google

DOCTOR_SITES   = ("ZocDoc", "Healthgrades", "Solv")
PHARMACY_SITES = ("CVS", "Walgreens", "GoodRx")


def _steel_headers() -> Dict[str, str]:
    h = {"Content-Type": "application/json"}
    if STEEL_API_KEY:
        h["X-API-Key"] = STEEL_API_KEY
    return h


# ---------------------------------------------------------------------------
# In-memory session registry
# Maps Steel session_id → { agent, mode, query, status, output, task, live_url }
# ---------------------------------------------------------------------------

_sessions: Dict[str, Dict[str, Any]] = {}
_lock = asyncio.Lock()


# ---------------------------------------------------------------------------
# Task templates
# ---------------------------------------------------------------------------

def _build_doctor_task(site: str, specialty: str, location: str) -> str:
    urls = {
        "ZocDoc": "https://www.zocdoc.com",
        "Healthgrades": "https://www.healthgrades.com",
        "Solv": "https://www.solvhealth.com",
    }
    return (
        f"You are a healthcare appointment search agent on {site}.\n"
        f"1. Go to {urls[site]}\n"
        f'2. Search for "{specialty}" doctors in "{location}"\n'
        "3. List up to 5 providers with their earliest available appointment time, address, and listing URL.\n"
        "4. Return a JSON object: "
        '{"source": "<site>", "appointments": [{"provider": "...", "specialty": "...", '
        '"time": "...", "address": "...", "listingUrl": "...", "acceptsInsurance": true|false}]}.\n'
        "Do not give medical advice."
    )


def _build_pharmacy_task(site: str, query: str) -> str:
    urls = {
        "CVS": "https://www.cvs.com",
        "Walgreens": "https://www.walgreens.com",
        "GoodRx": "https://www.goodrx.com",
    }
    return (
        f"You are a pharmacy/wellness product search agent on {site}.\n"
        f"1. Go to {urls[site]}\n"
        f'2. Search for "{query}"\n'
        "3. List up to 5 OTC products with price, dosage, and listing URL.\n"
        "4. Mark requiresPrescription=true ONLY if it is clearly Rx-only.\n"
        "5. Return JSON: "
        '{"source": "<site>", "items": [{"name": "...", "price": "...", "dosage": "...", '
        '"listingUrl": "...", "requiresPrescription": true|false}]}.'
    )


# ---------------------------------------------------------------------------
# Steel session lifecycle
# ---------------------------------------------------------------------------

async def _create_steel_session(client: httpx.AsyncClient) -> Dict[str, Any]:
    """Create a fresh Steel browser session and return its metadata."""
    resp = await client.post(
        f"{STEEL_BASE_URL}/v1/sessions",
        headers=_steel_headers(),
        json={"useProxy": False, "solveCaptcha": False},
        timeout=30.0,
    )
    resp.raise_for_status()
    data = resp.json()
    # Steel returns {id, sessionViewerUrl, websocketUrl, status, ...}
    return {
        "id": data["id"],
        "live_url": data.get("sessionViewerUrl") or data.get("debuggerFullscreenUrl") or "",
        "ws_url": data.get("websocketUrl") or data.get("webSocketDebuggerUrl") or "",
    }


async def _release_steel_session(session_id: str) -> None:
    try:
        async with httpx.AsyncClient() as client:
            await client.delete(
                f"{STEEL_BASE_URL}/v1/sessions/{session_id}/release",
                headers=_steel_headers(),
                timeout=10.0,
            )
    except Exception as e:
        logger.warning(f"[steel] release failed for {session_id}: {e}")


# ---------------------------------------------------------------------------
# browser-use runner
# ---------------------------------------------------------------------------

def _make_llm():
    """Pick an LLM client. Default OpenAI; fall back to Anthropic or Gemini."""
    provider = BROWSER_USE_LLM_PROVIDER.lower()
    if provider == "anthropic":
        from langchain_anthropic import ChatAnthropic  # type: ignore
        return ChatAnthropic(model=BROWSER_USE_LLM_MODEL, api_key=os.getenv("ANTHROPIC_API_KEY"))
    if provider == "google":
        from langchain_google_genai import ChatGoogleGenerativeAI  # type: ignore
        return ChatGoogleGenerativeAI(model=BROWSER_USE_LLM_MODEL, google_api_key=os.getenv("GEMINI_API_KEY"))
    # default openai
    from langchain_openai import ChatOpenAI  # type: ignore
    return ChatOpenAI(model=BROWSER_USE_LLM_MODEL, api_key=os.getenv("OPENAI_API_KEY"))


async def _run_browser_use(session_id: str, ws_url: str, task: str) -> None:
    """Run the browser-use Agent against a Steel CDP session and store the result."""
    try:
        from browser_use import Agent  # type: ignore
        from browser_use.browser.browser import Browser, BrowserConfig  # type: ignore
    except ImportError:
        async with _lock:
            _sessions[session_id]["status"] = "error"
            _sessions[session_id]["error"] = (
                "browser-use not installed. Run: pip install browser-use langchain-openai"
            )
        return

    try:
        browser = Browser(config=BrowserConfig(cdp_url=ws_url))
        agent = Agent(task=task, llm=_make_llm(), browser=browser)
        history = await agent.run(max_steps=20)

        # browser-use's history.final_result() returns the agent's final answer (string)
        # which the LLM should have formatted as JSON per our task prompt.
        final = history.final_result() if hasattr(history, "final_result") else None
        async with _lock:
            _sessions[session_id]["status"] = "idle"
            _sessions[session_id]["output"] = final or ""
        await browser.close()
    except Exception as e:
        logger.exception(f"[browser-use] run failed for {session_id}: {e}")
        async with _lock:
            _sessions[session_id]["status"] = "error"
            _sessions[session_id]["error"] = str(e)


# ---------------------------------------------------------------------------
# FastAPI router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/browser-local", tags=["browser-local"])


class StartRequest(BaseModel):
    mode: str  # "doctor" | "pharmacy"
    query: Optional[str] = None
    location: Optional[str] = None


class SessionIdRef(BaseModel):
    agent: str
    sessionId: str


class StatusRequest(BaseModel):
    sessionIds: List[SessionIdRef]


class StopRequest(BaseModel):
    sessionIds: List[str]


@router.post("/start")
async def start(req: StartRequest):
    if req.mode not in ("doctor", "pharmacy"):
        raise HTTPException(400, "mode must be 'doctor' or 'pharmacy'")

    sites = DOCTOR_SITES if req.mode == "doctor" else PHARMACY_SITES
    specialty = req.query or ("primary care" if req.mode == "doctor" else "cold and flu relief")
    location = req.location or "Los Angeles, CA"

    sessions_out: List[Dict[str, Any]] = []
    async with httpx.AsyncClient() as client:
        for site in sites:
            try:
                meta = await _create_steel_session(client)
                task = (
                    _build_doctor_task(site, specialty, location)
                    if req.mode == "doctor"
                    else _build_pharmacy_task(site, req.query or "OTC pain relief")
                )
                async with _lock:
                    _sessions[meta["id"]] = {
                        "agent": site,
                        "mode": req.mode,
                        "query": specialty,
                        "status": "running",
                        "output": None,
                        "live_url": meta["live_url"],
                        "task": task,
                    }
                # Fire-and-forget: browser-use runs the task; status endpoint polls completion
                asyncio.create_task(_run_browser_use(meta["id"], meta["ws_url"], task))
                sessions_out.append({
                    "agent": site,
                    "sessionId": meta["id"],
                    "liveUrl": meta["live_url"],
                    "status": "running",
                })
            except httpx.HTTPError as e:
                logger.warning(f"[browser-local] failed to start {site}: {e}")
                sessions_out.append({
                    "agent": site,
                    "sessionId": "",
                    "liveUrl": "",
                    "status": "error",
                    "error": f"Steel unreachable at {STEEL_BASE_URL} ({e})",
                })

    return {
        "mode": req.mode,
        "sessions": sessions_out,
        "started": sum(1 for s in sessions_out if s.get("sessionId")),
        "backend": "steel+browser-use",
    }


@router.post("/status")
async def status(req: StatusRequest):
    out: List[Dict[str, Any]] = []
    async with _lock:
        for ref in req.sessionIds:
            state = _sessions.get(ref.sessionId)
            if not state:
                out.append({
                    "agent": ref.agent,
                    "sessionId": ref.sessionId,
                    "status": "error",
                    "output": None,
                    "done": True,
                    "error": "session not found",
                })
                continue
            done = state["status"] in ("idle", "stopped", "error", "timed_out")
            out.append({
                "agent": ref.agent,
                "sessionId": ref.sessionId,
                "status": state["status"],
                "output": state.get("output") if done else None,
                "done": done,
                **({"error": state["error"]} if state.get("error") else {}),
            })
    return {"sessions": out}


@router.post("/stop")
async def stop(req: StopRequest):
    stopped = 0
    for sid in req.sessionIds:
        if not sid:
            continue
        async with _lock:
            state = _sessions.get(sid)
            if state:
                state["status"] = "stopped"
        await _release_steel_session(sid)
        stopped += 1
    return {"stopped": stopped}
