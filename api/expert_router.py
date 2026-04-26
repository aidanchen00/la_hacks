"""
MoE-style expert router.

After voice intake AND optional video analysis are both available, this picks
which downstream "expert" Prana frames the response around. Three labels:
  - "alternative_medicine" — low-acuity / lifestyle / holistic
  - "doctor"               — clinical presentation needing medical recommendation
  - "emergency"            — high-acuity, time-critical symptoms

Uses the existing OpenAI client from api/routing.py so we don't add a new LLM
dependency. Returns (expert, rationale).
"""
from __future__ import annotations

import json
import logging
from typing import Optional, Tuple

from api.routing import _get_client

logger = logging.getLogger("prana-expert-router")

ALLOWED_EXPERTS = ("alternative_medicine", "doctor", "emergency")

SYSTEM_PROMPT = """You are Prana's MoE expert router. Read the combined voice
intake and optional video analysis, then pick exactly one expert to handle the
case.

Experts:
- emergency: high-acuity / time-critical (chest pain, stroke signs, breathing
  difficulty, severe bleeding, suicidal intent, severe trauma).
- doctor: clinical presentation needing professional medical assessment (fever
  > 3 days, persistent unexplained pain, visible wounds/rashes/swelling,
  prescription-medication questions).
- alternative_medicine: low-acuity, lifestyle, wellness, stress, sleep,
  nutrition, holistic-care interest.

Return ONLY valid JSON: {"expert": "...", "rationale": "one sentence"}.
"""


async def route_expert(
    voice_summary: str,
    video_analysis: Optional[str],
) -> Tuple[str, str]:
    """Classify the run into one expert. Falls back to 'doctor' on any error
    so the demo never gets stuck without a route.
    """
    user_content = f"VOICE INTAKE:\n{(voice_summary or '').strip() or '(no voice intake)'}"
    if video_analysis:
        user_content += f"\n\nVIDEO ANALYSIS (Twelve Labs, English):\n{video_analysis.strip()}"
    else:
        user_content += "\n\nVIDEO ANALYSIS: (no video provided)"

    try:
        client = _get_client()  # may raise if OPENAI_API_KEY is unset
        resp = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            temperature=0,
            max_tokens=120,
        )
        raw = (resp.choices[0].message.content or "{}").strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        raw = raw.strip()
        data = json.loads(raw)
        expert = (data.get("expert") or "").strip()
        rationale = (data.get("rationale") or "").strip()
        if expert not in ALLOWED_EXPERTS:
            logger.warning("expert_router: invalid expert %r, defaulting to doctor", expert)
            return ("doctor", rationale or "Defaulted to doctor (router returned invalid expert).")
        return (expert, rationale or "No rationale provided.")
    except Exception as e:
        logger.error("expert_router failed: %s", e)
        return ("doctor", f"Defaulted to doctor (router error: {str(e)[:80]}).")
