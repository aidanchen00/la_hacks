"""
Run Prana agent bureau.

Usage:
    cd /Users/aidanchen/projects/la_hacks
    python agents/run_all.py
"""
import sys
import logging
from pathlib import Path
from dotenv import load_dotenv

# Load root .env before importing any agent (agents read env at import time)
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from uagents import Bureau
from agents.prana.agent import prana
from agents.budget.agent import budget_agent
from agents.shopping.cvs_agent import cvs
from agents.shopping.walgreens_agent import walgreens
from agents.shopping.goodrx_agent import goodrx
from agents.shopping.amazon_agent import amazon
from agents.appointments.zocdoc_agent import zocdoc
from agents.appointments.healthgrades_agent import healthgrades
from agents.appointments.solv_agent import solv
from agents.ranker.agent import ranker_agent

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("prana-bureau")


def main():
    logger.info("Starting Prana Agent Bureau…")
    logger.info(f"  prana         → {prana.address} (port 8100)")
    logger.info(f"  budget_agent  → {budget_agent.address} (port 8102)")
    logger.info(f"  cvs           → {cvs.address} (port 8103)")
    logger.info(f"  walgreens     → {walgreens.address} (port 8104)")
    logger.info(f"  goodrx        → {goodrx.address} (port 8105)")
    logger.info(f"  amazon        → {amazon.address} (port 8106)")
    logger.info(f"  ranker        → {ranker_agent.address} (port 8107)")
    logger.info(f"  zocdoc        → {zocdoc.address} (port 8108)")
    logger.info(f"  healthgrades  → {healthgrades.address} (port 8109)")
    logger.info(f"  solv          → {solv.address} (port 8110)")

    bureau = Bureau(port=8111)
    bureau.add(prana)
    bureau.add(budget_agent)
    bureau.add(cvs)
    bureau.add(walgreens)
    bureau.add(goodrx)
    bureau.add(amazon)
    bureau.add(ranker_agent)
    bureau.add(zocdoc)
    bureau.add(healthgrades)
    bureau.add(solv)

    logger.info("Bureau started. All agents listening.")
    bureau.run()


if __name__ == "__main__":
    main()
