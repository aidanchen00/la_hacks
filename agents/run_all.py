"""
Run CareFlow agent bureau.

Usage:
    cd /Users/aidanchen/projects/la_hacks
    python agents/run_all.py
"""
import sys
import logging
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from uagents import Bureau
from agents.careflow.agent import careflow
from agents.budget.agent import budget_agent
from agents.shopping.cvs_agent import cvs
from agents.shopping.walgreens_agent import walgreens
from agents.shopping.goodrx_agent import goodrx
from agents.shopping.amazon_agent import amazon

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("careflow-bureau")


def main():
    logger.info("Starting CareFlow Agent Bureau…")
    logger.info(f"  careflow      → {careflow.address} (port 8100)")
    logger.info(f"  budget_agent  → {budget_agent.address} (port 8102)")
    logger.info(f"  cvs           → {cvs.address} (port 8103)")
    logger.info(f"  walgreens     → {walgreens.address} (port 8104)")
    logger.info(f"  goodrx        → {goodrx.address} (port 8105)")
    logger.info(f"  amazon        → {amazon.address} (port 8106)")

    bureau = Bureau(port=8111)
    bureau.add(careflow)
    bureau.add(budget_agent)
    bureau.add(cvs)
    bureau.add(walgreens)
    bureau.add(goodrx)
    bureau.add(amazon)

    logger.info("Bureau started. All agents listening.")
    bureau.run()


if __name__ == "__main__":
    main()
