# Prana

Multilingual healthcare triage assistant — built for LA Hacks 2026. Describe your symptoms in English, Spanish, or Chinese and get a structured care recommendation (urgency, care path, estimated cost).

## Components

- `api/` — FastAPI control plane (`api.main:app`)
- `agents/` — uAgents (Agentverse-discoverable wellness, budget, shopping, ranker, appointments)
- `web/` — Next.js frontend (`/dashboard`, `/history`, etc.)
- `api/telegram_bot.py` — Telegram chat entry point (long-polling)

## Running locally

Install dependencies and copy `.env.example` to `.env`, filling in the keys you need.

```
make install
cp .env.example .env
```

Then start the services you need (each in its own terminal):

```
make run-api      # FastAPI on :8000
make run-agents   # uAgents bureau
make run-web      # Next.js on :3000
```

## Running the Telegram bot

The Telegram bot is an additional, optional entry point that routes incoming chats through the same triage logic the web frontend uses. Runs that come in via Telegram show up alongside web runs on `/history`, tagged `source="telegram"`.

1. Get a bot token from BotFather (open `@BotFather` on Telegram and send `/newbot`).
2. Add the token to `.env`:
   ```
   TELEGRAM_BOT_TOKEN=REDACTED_TOKEN_REVOKED   ```
3. Run the bot:
   ```
   python backend/telegram_bot.py
   ```
   (In this repo the file lives at `api/telegram_bot.py` — `python -m api.telegram_bot` or `python api/telegram_bot.py` both work.)
4. The bot runs as a separate process from the FastAPI server. A full demo uses 4 terminals: frontend (`make run-web`), backend (`make run-api`), ngrok, and the Telegram bot.

The bot supports `/start`, `/help`, `/about`, and any free-text symptom message in English, Spanish, or Chinese. Other languages get a polite trilingual fallback and are not sent to the triage LLM.
