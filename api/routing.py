"""LLM-powered intake routing — returns a RoutingDecision dict."""
import json
import os
from typing import Any, Dict

import openai

_client: openai.AsyncOpenAI | None = None


def _get_client() -> openai.AsyncOpenAI:
    global _client
    if _client is None:
        _client = openai.AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    return _client


ROUTING_SYSTEM = """You are the Prana Orchestrator. Analyze a wellness intake summary and return a JSON routing decision.

PATHS:
- doctor: symptoms suggest the user should see a physician (fever > 3 days, persistent pain, unexplained symptoms)
- pharmacy: OTC medication or supplement support needed, no urgent physician visit required
- mental_health: primary concern is stress, anxiety, burnout, depression, emotional distress
- alt_medicine: user is interested in traditional/alternative medicine practices
- self_care: mild wellness concern, general lifestyle guidance

URGENCY:
- emergency: potentially life-threatening (chest pain, difficulty breathing, stroke signs) → ALWAYS add 911 disclaimer
- urgent: needs medical attention within 24 hours
- routine: can be seen within a week
- wellness: preventive / educational

SAFETY RULES:
- requires_doctor_approval = true when pharmacy path AND symptoms could involve prescription medications
- Always include appropriate disclaimers
- Never diagnose. Use "may indicate", "could suggest", "consider consulting"

For doctor path, also pick:
- specialty: the medical specialty most relevant to the symptoms ("primary care", "urgent care",
  "dermatology", "cardiology", "orthopedist", "ENT", "ob/gyn", "pediatrician", "psychiatry", etc.).
  Default to "primary care" if unclear.
- location: extract a US city/area from the transcript if mentioned, otherwise default to "Los Angeles, CA".
For pharmacy path, also pick:
- query: 3-6 word OTC search phrase ("cold and flu relief", "ibuprofen 200mg", "vitamin D3 supplement").

Return ONLY valid JSON matching this schema:
{
  "urgency": "emergency|urgent|routine|wellness",
  "recommended_path": "doctor|pharmacy|mental_health|alt_medicine|self_care",
  "summary": "2-3 sentence wellness summary",
  "next_actions": ["action1", "action2", "action3"],
  "payment_required": false,
  "payment_amount_usd": 0.0,
  "requires_doctor_approval": false,
  "rationale": "Brief reasoning",
  "disclaimers": ["Disclaimer text"],
  "specialty": "primary care",
  "location": "Los Angeles, CA",
  "query": "cold and flu relief"
}"""


async def route_intake(transcript: str, summary: str) -> Dict[str, Any]:
    """Call OpenAI to classify and route the intake. Returns RoutingDecision dict."""
    client = _get_client()

    user_content = f"Intake transcript/symptoms: {transcript}\n\nSummary: {summary}"

    try:
        resp = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": ROUTING_SYSTEM},
                {"role": "user", "content": user_content},
            ],
            temperature=0,
            max_tokens=600,
        )
        raw = resp.choices[0].message.content or "{}"
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        raw = raw.strip()
        decision = json.loads(raw)
    except Exception as e:
        # Fallback mock decision if LLM fails
        decision = {
            "urgency": "wellness",
            "recommended_path": "self_care",
            "summary": summary or "Wellness intake recorded. Please review your dashboard for care options.",
            "next_actions": ["Review your dashboard", "Speak with a healthcare professional if symptoms persist"],
            "payment_required": False,
            "payment_amount_usd": 0.0,
            "requires_doctor_approval": False,
            "rationale": f"Fallback routing (LLM error: {str(e)[:60]})",
            "disclaimers": [
                "Prana is a wellness education tool, not a medical diagnosis service.",
                "Always consult a licensed healthcare professional for medical advice.",
            ],
        }

    # Ensure emergency disclaimer
    if decision.get("urgency") == "emergency":
        disclaimers = decision.get("disclaimers", [])
        if not any("911" in d or "emergency" in d.lower() for d in disclaimers):
            disclaimers.insert(0, "⚠️ EMERGENCY: Call 911 or go to the nearest emergency room immediately.")
        decision["disclaimers"] = disclaimers

    return decision
