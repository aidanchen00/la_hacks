"""
Horoscope Agent — seller side of the uAgents Payment Protocol.

Flow per request:
  1. Receive HoroscopeRequest(run_id, sign, name) from any caller
  2. Send RequestPayment for $0.99 (seller role)
  3. On CommitPayment, ack with CompletePayment and reply with HoroscopeResult
  4. On RejectPayment / CancelPayment, drop the pending session
"""
from __future__ import annotations

import logging
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from uagents import Agent, Context, Model, Protocol

from uagents_core.contrib.protocols.payment import (  # type: ignore
    CommitPayment,
    CompletePayment,
    RejectPayment,
    RequestPayment,
    Funds,
    payment_protocol_spec,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("horoscope-agent")


# ---------------------------------------------------------------------------
# Message types — kept local since horoscope is a self-contained service
# ---------------------------------------------------------------------------

class HoroscopeRequest(Model):
    run_id: str
    sign: str
    name: Optional[str] = None


class HoroscopeResult(Model):
    run_id: str
    sign: str
    date: str
    reading: str
    lucky_number: int
    paid_usd: float = 0.99


# ---------------------------------------------------------------------------
# Agent setup
# ---------------------------------------------------------------------------

HOROSCOPE_SEED = os.getenv("HOROSCOPE_SEED", "horoscope-prana-la-hacks-2026-seed-phrase-zodiac")
HOROSCOPE_PRICE_USD = 0.99

horoscope_agent = Agent(
    name="horoscope",
    seed=HOROSCOPE_SEED,
    port=8114,
    mailbox=True,
    publish_agent_details=True,
    readme_path=str(Path(__file__).parent / "README.md"),
    network="testnet",
)

logger.info(f"Horoscope agent address: {horoscope_agent.address}")

_pending: Dict[str, Dict[str, Any]] = {}

_READINGS: Dict[str, str] = {
    "aries":       "Bold action pays off today — channel that fire into one decisive move.",
    "taurus":      "Slow down and savor a small comfort. The grounded path is the right one.",
    "gemini":      "A conversation late in the day rewires how you see a stuck problem.",
    "cancer":      "Tend to the home base. A boundary you set now protects future joy.",
    "leo":         "Center stage suits you, but the spotlight feels best when shared.",
    "virgo":       "Resist the urge to fix what only needs to be witnessed.",
    "libra":       "A fair compromise emerges if you ask one more clarifying question.",
    "scorpio":     "Trust the quiet intuition tugging at you — it's been right twice this week.",
    "sagittarius": "An unscheduled detour leads you to exactly the person you needed to meet.",
    "capricorn":   "Discipline is paying interest. Allow yourself the rest you've earned.",
    "aquarius":    "Your odd idea isn't odd — it's early. Write it down before it drifts.",
    "pisces":      "Water finds its level. Stop forcing the shape and let the day pour.",
}

_LUCKY_NUMBERS: Dict[str, int] = {
    "aries": 9, "taurus": 6, "gemini": 5, "cancer": 2, "leo": 1, "virgo": 4,
    "libra": 7, "scorpio": 8, "sagittarius": 3, "capricorn": 10, "aquarius": 11, "pisces": 12,
}


def _normalize_sign(sign: str) -> str:
    return sign.strip().lower()


# ---------------------------------------------------------------------------
# HoroscopeRequest handler — kicks off the payment handshake
# ---------------------------------------------------------------------------

@horoscope_agent.on_message(HoroscopeRequest)
async def on_horoscope_request(ctx: Context, sender: str, msg: HoroscopeRequest) -> None:
    sign = _normalize_sign(msg.sign)
    if sign not in _READINGS:
        logger.warning(f"[horoscope] Unknown sign '{msg.sign}' from {sender[:20]}")
        return

    reference = f"horoscope:{msg.run_id}:{sign}"
    _pending[reference] = {
        "run_id": msg.run_id,
        "sign": sign,
        "name": msg.name,
        "caller_address": sender,
    }

    request = RequestPayment(
        accepted_funds=[
            Funds(
                currency="usd",
                amount=str(HOROSCOPE_PRICE_USD),
                payment_method="stripe",
            )
        ],
        recipient=ctx.agent.address,
        deadline_seconds=120,
        reference=reference,
        description=f"Daily horoscope reading for {sign.capitalize()}",
        metadata={"run_id": msg.run_id, "sign": sign},
    )
    await ctx.send(sender, request)
    logger.info(f"[horoscope] RequestPayment sent for {sign} (${HOROSCOPE_PRICE_USD:.2f})")


# ---------------------------------------------------------------------------
# Payment Protocol — seller role
# ---------------------------------------------------------------------------

payment_proto = Protocol(spec=payment_protocol_spec, role="seller")


@payment_proto.on_message(CommitPayment)
async def on_commit(ctx: Context, sender: str, msg: CommitPayment) -> None:
    ref = msg.reference or ""
    state = _pending.pop(ref, None)
    if not state:
        logger.warning(f"[horoscope] CommitPayment for unknown ref: {ref}")
        return

    txn_id = msg.transaction_id
    logger.info(f"[horoscope] CommitPayment received — txn={txn_id}")

    await ctx.send(sender, CompletePayment(transaction_id=txn_id))

    sign = state["sign"]
    result = HoroscopeResult(
        run_id=state["run_id"],
        sign=sign,
        date=datetime.utcnow().strftime("%Y-%m-%d"),
        reading=_READINGS[sign],
        lucky_number=_LUCKY_NUMBERS[sign],
        paid_usd=HOROSCOPE_PRICE_USD,
    )
    await ctx.send(state["caller_address"], result)
    logger.info(f"[horoscope] HoroscopeResult sent for {sign}")


@payment_proto.on_message(RejectPayment)
async def on_reject(ctx: Context, sender: str, msg: RejectPayment) -> None:
    logger.warning(f"[horoscope] RejectPayment from {sender[:20]}: {getattr(msg, 'reason', '')}")


horoscope_agent.include(payment_proto, publish_manifest=True)


if __name__ == "__main__":
    horoscope_agent.run()
