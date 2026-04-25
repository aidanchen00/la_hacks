# Steel Browser + local browser-use

Self-hosted browser automation with a hosted live-viewer URL. Replaces the
BrowserUse cloud SDK on the `aidan_browseruse_steel` branch — no per-task
quotas, you bring your own LLM key.

## Architecture

```
Next.js page
    │  POST /api/browser/start   (BROWSER_BACKEND=steel)
    ▼
Next.js route (web/src/app/api/browser/start/route.ts)
    │  forwards to FASTAPI_BASE_URL
    ▼
FastAPI router (api/browser_local.py)
    │  1. POST /v1/sessions on Steel  → session_id + sessionViewerUrl
    │  2. asyncio.create_task(_run_browser_use(session_id, ws_url, task))
    ▼
browser-use Agent (Python lib)
    │  drives Chromium via CDP using your OpenAI/Anthropic/Gemini key
    ▼
Steel Browser (Docker)
    │  hosts the Chromium instance + serves liveUrl
    ▼
Frontend iframe embeds liveUrl  ←  same shape as the cloud SDK
```

## Prerequisites

- Docker
- Python deps for the FastAPI server: `pip install -r api/requirements.txt`
  (this branch adds `browser-use` and `langchain-openai`)
- Playwright browsers: `python -m playwright install chromium`
  (browser-use uses Playwright internally; not strictly required since it'll
  drive Steel's Chromium remotely, but install it once to be safe)

## Setup

1. **Start Steel:**
   ```bash
   docker compose -f docker-compose.steel.yml up -d
   ```
   - API on `http://localhost:3000`
   - Built-in UI on `http://localhost:5173`
   - First boot pulls ~700MB image, takes ~30s.

2. **Add to `.env`:**
   ```
   BROWSER_BACKEND=steel
   STEEL_BASE_URL=http://localhost:3000
   # STEEL_API_KEY=                 # optional, only if you set one in the container
   BROWSER_USE_LLM_PROVIDER=openai  # openai | anthropic | google
   BROWSER_USE_LLM_MODEL=gpt-4o-mini
   ```

3. **Restart FastAPI + Next.js** so the new env values are picked up.

4. **Test:** open the pharmacy or doctor page and start a search. The
   `liveUrl` iframe will load Steel's session viewer.

## Switching back to cloud BrowserUse

Comment out / unset `BROWSER_BACKEND=steel`. The Next.js routes fall through
to the existing cloud SDK code path. Both paths can coexist — the env flag is
the only switch.

## Troubleshooting

- **Iframe shows nothing.** Check `docker logs steel-browser` and confirm
  `sessionViewerUrl` is reachable from the browser (open it directly in a tab).
- **`browser-use not installed`.** `pip install browser-use langchain-openai`
  in the same Python env that runs `uvicorn`.
- **Empty output.** browser-use returns `history.final_result()` — if the LLM
  didn't produce JSON in its final answer, raw text comes back. Adjust the
  task prompt in `api/browser_local.py` (`_build_doctor_task` /
  `_build_pharmacy_task`) to be stricter about format.
- **Concurrent session limit.** Steel handles N sessions per container; bump
  `shm_size` in the compose file if Chromium tabs start crashing.

## Tradeoffs vs cloud BrowserUse SDK

| | Cloud BrowserUse | Steel + browser-use |
|---|---|---|
| Cost | $$ + 10 free task quota | LLM tokens only |
| Setup | API key | Docker container + Python deps |
| LLM choice | They pick | You pick (OpenAI/Anthropic/Gemini/Ollama) |
| Live stream | Built-in `liveUrl` | Built-in `sessionViewerUrl` (same iframe) |
| Concurrency | Plan-capped | Container-capped |
| Quota cliff | Yes | No |
