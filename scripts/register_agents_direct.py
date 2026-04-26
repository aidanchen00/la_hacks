"""
Register each Prana uAgent on Agentverse by calling the
mailbox registration API directly (bypasses Bureau /connect routing).

Usage:
    python scripts/register_agents_direct.py
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT))

from uagents.mailbox import register_in_agentverse  # type: ignore
from uagents_core.registration import (
    AgentverseConnectRequest,
    AgentProfile,
    RegistrationRequest,
)

from agents.prana.agent import prana
from agents.budget.agent import budget_agent
from agents.shopping.cvs_agent import cvs
from agents.shopping.walgreens_agent import walgreens
from agents.shopping.goodrx_agent import goodrx
from agents.shopping.amazon_agent import amazon
from agents.ranker.agent import ranker_agent
from agents.appointments.zocdoc_agent import zocdoc
from agents.appointments.healthgrades_agent import healthgrades
from agents.appointments.solv_agent import solv


AGENTS = [
    ("prana", prana),
    ("budget", budget_agent),
    ("cvs", cvs),
    ("walgreens", walgreens),
    ("goodrx", goodrx),
    ("amazon", amazon),
    ("ranker", ranker_agent),
    ("zocdoc", zocdoc),
    ("healthgrades", healthgrades),
    ("solv", solv),
]


async def register_one(name: str, agent) -> bool:
    request = AgentverseConnectRequest(
        user_token=TOKEN,
        agent_type="mailbox",
        endpoint=None,
        team=None,
    )

    profile = AgentProfile(
        description=getattr(agent, "_description", "") or f"{name} agent",
        readme=agent._readme or "",
        avatar_url="",
    )

    details = RegistrationRequest(
        address=agent.address,
        name=agent.name,
        handle=None,
        url=None,
        agent_type="mailbox",
        profile=profile,
        endpoints=agent._endpoints or [],
        protocols=list(agent.protocols.keys()),
        metadata=agent.metadata,
    )

    print(f"[{name}] {agent.address}")
    try:
        resp = await register_in_agentverse(
            request=request,
            identity=agent._identity,
            prefix=agent._prefix,
            agentverse=agent._agentverse,
            agent_details=details,
        )
        if resp.success:
            print(f"  ✓ registered")
            return True
        print(f"  ✗ failed: {resp.detail}")
        return False
    except Exception as e:
        print(f"  ✗ error: {e}")
        return False


async def main() -> None:
    global TOKEN
    TOKEN = os.getenv("AGENTVERSE_API_KEY", "").strip()
    if not TOKEN:
        print("ERROR: AGENTVERSE_API_KEY not set in .env")
        sys.exit(1)

    print(f"AGENTVERSE_API_KEY found ({len(TOKEN)} chars)\n")

    results: list[tuple[str, bool]] = []
    for name, agent in AGENTS:
        ok = await register_one(name, agent)
        results.append((name, ok))
        print()

    print("─" * 40)
    passed = sum(1 for _, ok in results if ok)
    for name, ok in results:
        print(f"  {'✓' if ok else '✗'} {name}")
    print(f"\n{passed}/{len(results)} agents registered.")
    if passed < len(results):
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
