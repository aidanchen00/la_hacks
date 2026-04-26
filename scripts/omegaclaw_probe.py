"""
OmegaClaw / ASI:One probe script.
Sends a ChatMessage to the Prana Agentverse agent and prints the RoutingDecision response.

Usage:
    python scripts/omegaclaw_probe.py --text "I have had a sore throat for 3 days"
    python scripts/omegaclaw_probe.py --to agent1q... --text "feeling anxious and burnt out"
"""
import argparse
import asyncio
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.chat import (  # type: ignore
    ChatAcknowledgement,
    ChatMessage,
    TextContent,
    chat_protocol_spec,
)

# The Prana agent's Agentverse address (set via CLI or env)
PRANA_ADDRESS = os.getenv("PRANA_AGENT_ADDRESS", "")


def main():
    parser = argparse.ArgumentParser(description="Probe Prana agent via Chat Protocol")
    parser.add_argument("--to", default=PRANA_ADDRESS, help="Prana agent address")
    parser.add_argument("--text", required=True, help="Health/wellness concern to send")
    args = parser.parse_args()

    if not args.to:
        print("❌ No agent address. Set PRANA_AGENT_ADDRESS env or use --to <address>")
        sys.exit(1)

    probe = Agent(name="omegaclaw-probe", seed="omegaclaw-probe-seed-prana-2026", port=8200)
    chat_proto = Protocol(spec=chat_protocol_spec)
    received_reply = asyncio.Event()

    @chat_proto.on_message(ChatMessage)
    async def on_reply(ctx: Context, sender: str, msg: ChatMessage):
        print(f"\n✅ Prana reply from {sender[:30]}:")
        for item in msg.content:
            if isinstance(item, TextContent):
                print(item.text)
        received_reply.set()

    @chat_proto.on_message(ChatAcknowledgement)
    async def on_ack(_ctx: Context, sender: str, _msg: ChatAcknowledgement):
        print(f"📨 Acknowledged by {sender[:30]}")

    probe.include(chat_proto)

    @probe.on_event("startup")
    async def send_message(ctx: Context):
        print(f"\n🩺 Sending to Prana ({args.to[:30]}…):")
        print(f"   \"{args.text}\"\n")
        await ctx.send(
            args.to,
            ChatMessage(
                timestamp=datetime.utcnow(),
                msg_id=uuid4(),
                content=[TextContent(type="text", text=args.text)],
            ),
        )

    @probe.on_interval(period=30.0)
    async def timeout(ctx: Context):
        if received_reply.is_set():
            return
        print("⏰ Timeout — no reply after 30s. Check if Prana agent is running.")
        await ctx.stop()

    probe.run()


if __name__ == "__main__":
    main()
