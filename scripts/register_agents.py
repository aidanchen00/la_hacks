"""
Register all Prana uAgents on Agentverse.

Polls each agent's local inspector until it's up, then POSTs to /connect
with the AGENTVERSE_API_KEY so agent details (name, README, protocols)
are published to the Agentverse registry.

Usage:
    # In a second terminal after `make run-agents`:
    python scripts/register_agents.py

    # Or pass the token directly:
    AGENTVERSE_API_KEY=eyJ... python scripts/register_agents.py
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

AGENTS = [
    {"name": "prana",     "port": 8100},
    {"name": "budget",       "port": 8102},
    {"name": "cvs",          "port": 8103},
    {"name": "walgreens",    "port": 8104},
    {"name": "goodrx",       "port": 8105},
    {"name": "amazon",       "port": 8106},
    {"name": "ranker",       "port": 8107},
    {"name": "zocdoc",       "port": 8108},
    {"name": "healthgrades", "port": 8109},
    {"name": "solv",         "port": 8110},
]

CONNECT_TIMEOUT   = 120   # seconds to wait for each agent to come up
POLL_INTERVAL     = 2     # seconds between readiness checks


def wait_for_agent(port: int, name: str) -> bool:
    """Poll agent inspector until it responds or timeout."""
    deadline = time.time() + CONNECT_TIMEOUT
    url = f"http://localhost:{port}"
    print(f"  Waiting for {name} on :{port} ...", end="", flush=True)
    while time.time() < deadline:
        try:
            r = httpx.get(url, timeout=2)
            if r.status_code < 500:
                print(" ready")
                return True
        except Exception:
            pass
        time.sleep(POLL_INTERVAL)
        print(".", end="", flush=True)
    print(" TIMEOUT")
    return False


def register_agent(port: int, name: str, token: str) -> bool:
    url = f"http://localhost:{port}/connect"
    payload = {"user_token": token, "agent_type": "mailbox"}
    try:
        r = httpx.post(url, json=payload, timeout=15)
        if r.status_code == 200:
            data = r.json()
            if data.get("success"):
                print(f"  ✓ {name} registered on Agentverse")
                return True
            print(f"  ✗ {name} connect failed: {data.get('detail', r.text)}")
        else:
            print(f"  ✗ {name} HTTP {r.status_code}: {r.text[:200]}")
    except Exception as e:
        print(f"  ✗ {name} error: {e}")
    return False


def main() -> None:
    token = os.getenv("AGENTVERSE_API_KEY", "").strip()
    if not token:
        print("ERROR: AGENTVERSE_API_KEY is not set in .env or environment.")
        sys.exit(1)

    print(f"AGENTVERSE_API_KEY found ({len(token)} chars)\n")
    print("Registering agents on Agentverse...\n")

    results: list[tuple[str, bool]] = []
    for agent in AGENTS:
        name, port = agent["name"], agent["port"]
        print(f"[{name}]")
        if wait_for_agent(port, name):
            ok = register_agent(port, name, token)
        else:
            print(f"  ✗ {name} not reachable — skipping")
            ok = False
        results.append((name, ok))
        print()

    print("─" * 40)
    passed = sum(1 for _, ok in results if ok)
    for name, ok in results:
        status = "✓" if ok else "✗"
        print(f"  {status} {name}")
    print(f"\n{passed}/{len(results)} agents registered.")

    if passed < len(results):
        print("\nTip: make sure `make run-agents` is running before registering.")
        sys.exit(1)


if __name__ == "__main__":
    main()
