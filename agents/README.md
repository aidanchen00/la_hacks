# Prana uAgents

Fetch.ai uAgent bureau: prana orchestrator + budget + 4 shopping agents (CVS,
Walgreens, GoodRx, Amazon) + 2 appointment agents (Healthgrades, Solv) + ranker.

## Local browser scraping

As of the `playwright-swap` branch, the shopping and appointment agents scrape
sites with **local Playwright** instead of the paid BrowserUse SaaS. No API
keys required.

### One-time setup

```bash
pip3 install -r agents/requirements.txt
playwright install chromium
```

### HEADLESS env var

By default Chromium runs invisibly in the background:

```
HEADLESS=true   # default — invisible
HEADLESS=false  # browser windows pop up so judges can SEE the agents work
```

Set in `.env` or inline: `HEADLESS=false make run-agents`.

### Live vs mock

Each agent attempts a live scrape first; on selector failure / bot wall /
timeout it falls back to a hardcoded mock so the demo never blanks. Watch the
bureau logs for the path each agent takes:

```
[goodrx] live (Playwright): Generic Ibuprofen 200mg     ← live
[cvs]    mock fallback: CVS Health Ibuprofen 200mg (mock) ← mock
```

CVS / Walgreens / Amazon hit anti-bot walls aggressively from headless
Chromium. Expect those to fall back to mock most of the time. GoodRx and
Healthgrades typically succeed.

### Cleanup

`agents/shared/playwright_browser.py` always closes the browser context in a
`finally` block. After a run:

```bash
ps aux | grep -E "ms-playwright|playwright/.*chromium" | grep -v grep
# (should print nothing — Adobe Creative Cloud chromium procs are unrelated)
```
