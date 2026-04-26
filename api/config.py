"""Prana FastAPI configuration."""
import os
from pathlib import Path

# Repo root is one level above api/
REPO_ROOT = Path(__file__).resolve().parent.parent

DATABASE_PATH = str(REPO_ROOT / "prana.db")

FASTAPI_CALLBACK_URL = os.getenv("FASTAPI_CALLBACK_URL", "http://localhost:8000/internal/agent-event")
FASTAPI_BASE_URL = os.getenv("FASTAPI_BASE_URL", "http://localhost:8000")

CORS_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3000",
]

STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY", "")
STRIPE_PUBLISHABLE_KEY = os.getenv("STRIPE_PUBLISHABLE_KEY", "")
AGENTVERSE_API_KEY = os.getenv("AGENTVERSE_API_KEY", "")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
