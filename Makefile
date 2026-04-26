.PHONY: install run run-api run-agents run-livekit run-web health reset-db logs register

# ─── Install all deps ──────────────────────────────────────────────────────────
install:
	@echo "→ Installing Python API deps…"
	cd $(CURDIR) && pip install -r api/requirements.txt
	@echo "→ Installing Python agent deps…"
	cd $(CURDIR) && pip install -r agents/requirements.txt
	@echo "→ Installing Node web deps…"
	cd web && npm install --legacy-peer-deps
	@echo "→ Installing Node livekit agent deps…"
	cd web/livekit && npm install --legacy-peer-deps
	@echo "✓ All deps installed"

# ─── Run everything (requires tmux) ───────────────────────────────────────────
run:
	tmux new-session -d -s careflow -x 220 -y 50 \
		"make run-api 2>&1 | tee /tmp/careflow-api.log; read" \; \
		split-window -h "make run-agents 2>&1 | tee /tmp/careflow-agents.log; read" \; \
		split-window -v "make run-web 2>&1 | tee /tmp/careflow-web.log; read" \; \
		select-layout tiled \; \
		attach

# ─── Individual services ───────────────────────────────────────────────────────
# All targets source env from web/.env.local (single source of truth, shared
# with the Next.js app); repo-root .env stays as a fallback. set -a / set +a
# is safer than `xargs` for values containing spaces or special characters.
run-api:
	@echo "→ Starting Prana FastAPI on :8000"
	cd $(CURDIR) && \
		set -a; [ -f .env ] && . ./.env; [ -f web/.env.local ] && . ./web/.env.local; set +a; \
		python3 -m uvicorn api.main:app --host 0.0.0.0 --port 8000 --reload

run-agents:
	@echo "→ Starting Prana uAgent bureau on :8100"
	cd $(CURDIR) && \
		set -a; [ -f .env ] && . ./.env; [ -f web/.env.local ] && . ./web/.env.local; set +a; \
		python3 agents/run_all.py

run-livekit:
	@echo "→ Starting CareFlow LiveKit voice agent"
	cd web/livekit && \
		set -a; [ -f ../../.env ] && . ../../.env; [ -f ../.env.local ] && . ../.env.local; set +a; \
		npm run agent

run-web:
	@echo "→ Starting CareFlow Next.js on :3000"
	cd web && \
		npm run dev

# ─── Health check ─────────────────────────────────────────────────────────────
health:
	@curl -sf http://localhost:8000/health && echo " ✓ API healthy" || echo " ✗ API not responding"
	@curl -sf http://localhost:3000 -o /dev/null && echo " ✓ Web healthy" || echo " ✗ Web not responding"

# ─── OmegaClaw probe ──────────────────────────────────────────────────────────
probe:
	@echo "→ Probing CareFlow agent via ASI:One Chat Protocol"
	cd $(CURDIR) && \
		set -a; [ -f .env ] && . ./.env; [ -f web/.env.local ] && . ./web/.env.local; set +a; \
		python3 scripts/omegaclaw_probe.py --text "I have had a sore throat and low-grade fever for 3 days"

# ─── Register agents on Agentverse ───────────────────────────────────────────
register:
	@echo "→ Registering CareFlow agents on Agentverse"
	cd $(CURDIR) && \
		set -a; [ -f .env ] && . ./.env; [ -f web/.env.local ] && . ./web/.env.local; set +a; \
		python3 scripts/register_agents.py

# ─── Reset DB ─────────────────────────────────────────────────────────────────
reset-db:
	@rm -f careflow.db
	@echo "✓ careflow.db removed"
