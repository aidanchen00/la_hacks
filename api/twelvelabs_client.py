"""
Twelve Labs video-understanding client for Prana.

Handles:
  - Bootstrapping a Marengo index on first run (auto-creates if
    TWELVE_LABS_INDEX_ID is missing, prints the new id).
  - Uploading video files and polling indexing tasks.
  - Running Generate prompts against an indexed video.

Twelve Labs supports ONLY English video understanding currently — that's a
platform limitation, not a bug. Audio inside the video can be in any language
but the visual-language responses come back in English.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Dict, Optional

import httpx

logger = logging.getLogger("prana-twelvelabs")

API_BASE = "https://api.twelvelabs.io/v1.3"
DEFAULT_INDEX_NAME = "prana-demo"
# Marengo is Twelve Labs' multimodal embedding/indexing model.
# As of mid-2026, the current Marengo Generative model is "marengo2.7".
DEFAULT_MODEL = "marengo2.7"

# Cache the resolved index id within a single process so we don't recreate it
# on every request even if the user never updates .env after first boot.
_cached_index_id: Optional[str] = None


def _api_key() -> str:
    return (os.getenv("TWELVE_LABS_API_KEY") or "").strip()


def is_enabled() -> bool:
    """True iff a Twelve Labs API key is configured."""
    return bool(_api_key())


def _headers() -> Dict[str, str]:
    return {"x-api-key": _api_key()}


# ---------------------------------------------------------------------------
# Index bootstrap
# ---------------------------------------------------------------------------

async def ensure_index() -> Optional[str]:
    """Resolve the index id. Reads TWELVE_LABS_INDEX_ID; if blank, creates a new
    Marengo index named 'prana-demo' and prints the id so the user can save it
    to .env. Returns None when the API key is missing (feature disabled).
    """
    global _cached_index_id
    if _cached_index_id:
        return _cached_index_id
    if not is_enabled():
        logger.warning(
            "TWELVE_LABS_API_KEY not set — video understanding feature disabled."
        )
        return None

    env_id = (os.getenv("TWELVE_LABS_INDEX_ID") or "").strip()
    if env_id:
        _cached_index_id = env_id
        logger.info("Twelve Labs: using configured index_id %s", env_id)
        return env_id

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                f"{API_BASE}/indexes",
                headers=_headers(),
                json={
                    "index_name": DEFAULT_INDEX_NAME,
                    "models": [{
                        "model_name": DEFAULT_MODEL,
                        "model_options": ["visual", "audio"],
                    }],
                },
            )
        if resp.status_code not in (200, 201):
            logger.error(
                "Twelve Labs: failed to create index (status %d): %s",
                resp.status_code, resp.text[:300],
            )
            return None
        data = resp.json()
        new_id = data.get("_id") or data.get("id") or data.get("index_id")
        if not new_id:
            logger.error("Twelve Labs: create-index returned no id: %s", data)
            return None
        _cached_index_id = new_id
        # Loud, copy-paste-friendly log line per the spec.
        print(
            f"\n  TWELVE_LABS_INDEX_ID created: {new_id}. "
            f"Add this to your .env file.\n"
        )
        logger.info("Twelve Labs: created new index %s (name=%s)",
                    new_id, DEFAULT_INDEX_NAME)
        return new_id
    except Exception as e:
        logger.error("Twelve Labs: ensure_index failed: %s", e)
        return None


# ---------------------------------------------------------------------------
# Upload + polling
# ---------------------------------------------------------------------------

async def upload_video(file_path: str, run_id: str) -> Optional[str]:
    """Upload a local video file. Returns the indexing task_id or None on error."""
    if not is_enabled():
        return None
    index_id = await ensure_index()
    if not index_id:
        return None
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            with open(file_path, "rb") as f:
                files = {"video_file": (os.path.basename(file_path), f, "video/mp4")}
                data = {"index_id": index_id, "language": "en"}
                resp = await client.post(
                    f"{API_BASE}/tasks",
                    headers=_headers(),
                    files=files,
                    data=data,
                )
        latency_ms = int((time.monotonic() - started) * 1000)
        if resp.status_code not in (200, 201):
            logger.error(
                "[twelvelabs] run=%s upload failed status=%d latency_ms=%d body=%s",
                run_id[:8], resp.status_code, latency_ms, resp.text[:300],
            )
            return None
        body = resp.json()
        task_id = body.get("_id") or body.get("id")
        logger.info(
            "[twelvelabs] run=%s upload ok task=%s latency_ms=%d",
            run_id[:8], task_id, latency_ms,
        )
        return task_id
    except Exception as e:
        logger.error("[twelvelabs] run=%s upload exception: %s", run_id[:8], e)
        return None


async def poll_task(task_id: str, run_id: str, max_seconds: int = 180) -> Optional[str]:
    """Poll an indexing task until ready. Returns video_id on success, else None."""
    if not is_enabled():
        return None
    deadline = time.monotonic() + max_seconds
    attempt = 0
    while time.monotonic() < deadline:
        attempt += 1
        started = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.get(
                    f"{API_BASE}/tasks/{task_id}", headers=_headers()
                )
            latency_ms = int((time.monotonic() - started) * 1000)
            if resp.status_code != 200:
                logger.warning(
                    "[twelvelabs] run=%s poll task=%s status=%d latency_ms=%d",
                    run_id[:8], task_id, resp.status_code, latency_ms,
                )
                await asyncio.sleep(3)
                continue
            data = resp.json()
            status = (data.get("status") or "").lower()
            video_id = data.get("video_id")
            logger.info(
                "[twelvelabs] run=%s poll task=%s status=%s attempt=%d latency_ms=%d",
                run_id[:8], task_id, status, attempt, latency_ms,
            )
            if status == "ready":
                return video_id
            if status in ("failed", "error"):
                return None
        except Exception as e:
            logger.error("[twelvelabs] run=%s poll exception: %s", run_id[:8], e)
        await asyncio.sleep(3)
    logger.error("[twelvelabs] run=%s poll task=%s timed out", run_id[:8], task_id)
    return None


# ---------------------------------------------------------------------------
# Generate (open-ended prompt against an indexed video)
# ---------------------------------------------------------------------------

async def generate(video_id: str, prompt: str, run_id: str) -> Optional[str]:
    """Run a Generate query against an indexed video. Returns the text or None."""
    if not is_enabled() or not video_id:
        return None
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                f"{API_BASE}/generate",
                headers=_headers(),
                json={"video_id": video_id, "prompt": prompt, "temperature": 0.2},
            )
        latency_ms = int((time.monotonic() - started) * 1000)
        if resp.status_code != 200:
            logger.error(
                "[twelvelabs] run=%s generate failed status=%d latency_ms=%d body=%s",
                run_id[:8], resp.status_code, latency_ms, resp.text[:300],
            )
            return None
        body: Dict[str, Any] = resp.json()
        text = body.get("data") or body.get("text") or body.get("result")
        logger.info(
            "[twelvelabs] run=%s generate ok latency_ms=%d chars=%d",
            run_id[:8], latency_ms, len(text or ""),
        )
        return (text or "").strip() or None
    except Exception as e:
        logger.error("[twelvelabs] run=%s generate exception: %s", run_id[:8], e)
        return None
