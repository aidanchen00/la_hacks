---
name: healthcare-test-fixtures
version: 1.0.0
description: >
  Use this skill when a developer needs to generate realistic synthetic triage data,
  healthcare test fixtures, sample patient scenarios, or mock RoutingDecision objects
  for a healthcare application. Routes test prompts to the Prana CareFlow agent on
  Agentverse, which returns structured triage decisions including urgency level
  (emergency/urgent/routine/wellness), natural-language summaries, suggested next steps,
  and recommended care paths. Use when the developer says "generate test data for
  healthcare", "give me sample triage scenarios", "I need fixtures for my health app",
  "mock a RoutingDecision", or similar. Do NOT use this skill for actual medical advice
  — it generates synthetic developer test data only.
tags:
  - healthcare
  - testing
  - fixtures
  - triage
  - agentverse
agent_address: agent1qf8x5lr29e9s55q8jxu70v3jlcwg4vg7ctanssllhy47wkpttavvx4mkqma
protocol: uagents-chat-protocol
---

# Healthcare Test Fixtures

Generate realistic synthetic healthcare triage data by routing test prompts to the live
**Prana CareFlow** agent on Agentverse. CareFlow runs GPT-4o-mini under the hood and
returns structured `RoutingDecision` objects — the same data your app will receive in
production. This is not mocked or hardcoded: every fixture is a real agent response.

---

## When to use this skill

Activate this skill when the developer says something like:

- "generate test data for [healthcare / triage / symptoms]"
- "give me sample triage scenarios"
- "create fixtures for [a / my] healthcare app"
- "mock a RoutingDecision"
- "I need realistic synthetic patient data"
- "seed my health app's database"
- "what does CareFlow return for [scenario]?"
- "I need fixtures with mixed urgency levels"
- "show me edge cases for triage"

---

## When NOT to use this skill

- The user is asking for **actual medical advice** — redirect them to real medical resources; this skill is for developer test data only
- The user wants **real patient data** — this generates synthetic data only; never use real patient information
- The user needs **HIPAA-compliant production data** — this is for development environments only

---

## How this skill works

1. Read the developer's request and determine how many scenarios they need and what variety (urgency mix, age range, symptom types, edge cases, etc.)
2. Construct one synthetic patient prompt per scenario — vary urgency levels, ages, and symptom descriptions to match the developer's intent
3. Send each prompt to the CareFlow agent via the Agentverse Chat Protocol (see **Invocation** below)
4. Collect the `RoutingDecision` responses
5. Return them as a JSON array the developer can paste directly into their fixtures file

---

## Response shape

CareFlow returns a structured routing decision. The canonical model (from `agents/shared/messages.py`):

```typescript
type RoutingDecision = {
  run_id: string;                  // UUID, auto-generated per request
  urgency: "emergency" | "urgent" | "routine" | "wellness";
  recommended_path: "doctor" | "pharmacy" | "mental_health" | "alt_medicine" | "self_care";
  summary: string;                 // 2-3 sentence natural-language wellness summary
  next_actions: string[];          // concrete steps the patient should take
  payment_required: boolean;       // always false for test fixtures
  payment_amount_usd: number;      // always 0.0 for test fixtures
  requires_doctor_approval: boolean;
  rationale: string;               // internal reasoning (useful for test assertions)
  disclaimers: string[];           // safety notices always appended
};
```

> **Note:** The agent returns this as formatted plain text over the Chat Protocol, not raw JSON.
> Parse the text response into the shape above when building your fixtures file.

---

## Invocation

CareFlow speaks the **Agentverse Chat Protocol** (`uagents_core.contrib.protocols.chat`).
Call it with a `ChatMessage` containing a `TextContent` block — the text is the synthetic
patient prompt.

**Agent address:** `agent1qf8x5lr29e9s55q8jxu70v3jlcwg4vg7ctanssllhy47wkpttavvx4mkqma`

### Python (uagents client)

This is the canonical invocation pattern, mirrored from `scripts/omegaclaw_probe.py`:

```python
import asyncio
from datetime import datetime
from uuid import uuid4

from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    TextContent,
    chat_protocol_spec,
)

CAREFLOW_ADDRESS = "agent1qf8x5lr29e9s55q8jxu70v3jlcwg4vg7ctanssllhy47wkpttavvx4mkqma"

async def call_careflow(prompt: str) -> str:
    """Send a synthetic patient prompt to CareFlow and return the response text."""
    result = {}
    probe = Agent(name="fixture-probe", seed=f"fixture-probe-{uuid4()}", port=8300)
    chat_proto = Protocol(spec=chat_protocol_spec)

    @chat_proto.on_message(ChatMessage)
    async def on_reply(ctx: Context, sender: str, msg: ChatMessage):
        for item in msg.content:
            if isinstance(item, TextContent):
                result["text"] = item.text
        await ctx.stop()

    @chat_proto.on_message(ChatAcknowledgement)
    async def on_ack(_ctx, _sender, _msg):
        pass

    probe.include(chat_proto)

    @probe.on_event("startup")
    async def send(ctx: Context):
        await ctx.send(
            CAREFLOW_ADDRESS,
            ChatMessage(
                timestamp=datetime.utcnow(),
                msg_id=uuid4(),
                content=[TextContent(type="text", text=prompt)],
            ),
        )

    probe.run()
    return result.get("text", "")
```

You can also use the existing probe script directly:

```bash
python scripts/omegaclaw_probe.py \
  --to agent1qf8x5lr29e9s55q8jxu70v3jlcwg4vg7ctanssllhy47wkpttavvx4mkqma \
  --text "45-year-old with chest tightness and shortness of breath for 20 minutes"
```

### Agentverse REST API (alternative)

If the developer's environment can't run a uagents process, they can call CareFlow via
the Agentverse REST proxy. Replace `$AGENTVERSE_API_KEY` with a key from
[agentverse.ai](https://agentverse.ai):

```bash
curl -X POST https://agentverse.ai/v1/submit \
  -H "Authorization: Bearer $AGENTVERSE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "agent1qf8x5lr29e9s55q8jxu70v3jlcwg4vg7ctanssllhy47wkpttavvx4mkqma",
    "message": {
      "type": "chat_message",
      "content": [{ "type": "text", "text": "32-year-old with mild sore throat for 2 days, no fever" }]
    }
  }'
```

---

## Example interactions

### Example 1 — Diverse fixtures

**Developer prompt:**
> "Generate 5 triage scenarios with mixed urgency levels for my healthcare app's test suite"

**Skill behavior:**
1. Construct 5 synthetic prompts, one per urgency level (plus one repeat to test consistency):
   - Emergency: "68-year-old male, sudden severe chest pain radiating to left arm, sweating"
   - Urgent: "29-year-old with 104°F fever, stiff neck, and sensitivity to light"
   - Routine: "40-year-old with persistent lower back pain for 3 weeks, no injury"
   - Wellness: "35-year-old wants advice on improving sleep and managing work stress"
   - Routine (repeat): "55-year-old with mild joint stiffness in the morning, improves by midday"
2. Call CareFlow for each prompt
3. Return an array of 5 `RoutingDecision` objects as JSON

**Expected urgency distribution:** 1× emergency, 1× urgent, 2× routine, 1× wellness

---

### Example 2 — Specific scenario

**Developer prompt:**
> "Mock a RoutingDecision for chest pain in a 55-year-old"

**Skill behavior:**
1. Construct a single prompt: `"55-year-old experiencing chest pain"`
2. Call CareFlow once
3. Return a single `RoutingDecision` object

**Expected result:** `urgency: "emergency"`, `recommended_path: "doctor"`, next_actions
include calling 911 and going to the nearest ER, disclaimers note this is not a diagnosis.

---

### Example 3 — Edge cases

**Developer prompt:**
> "Give me triage data for ambiguous symptoms — things that are hard to classify"

**Skill behavior:**
1. Construct prompts with vague or multi-system symptoms:
   - "25-year-old, fatigue for 2 weeks, no other symptoms"
   - "42-year-old with intermittent headache and mild nausea, no fever"
   - "30-year-old with nonspecific abdominal discomfort, comes and goes"
2. Call CareFlow for each
3. Return the RoutingDecisions — useful for verifying how your UI handles
   `routine`/`wellness` boundary cases and ambiguous `recommended_path` assignments

---

## Output format

Return all fixtures in a single fenced JSON block, ready to paste into a test file.
Always prepend the source comment:

```json
// Generated by Prana CareFlow via the healthcare-test-fixtures skill
// Synthetic test data — do not use for actual medical decisions
[
  {
    "run_id": "a1b2c3d4-...",
    "urgency": "emergency",
    "recommended_path": "doctor",
    "summary": "...",
    "next_actions": ["Call 911 immediately", "..."],
    "payment_required": false,
    "payment_amount_usd": 0.0,
    "requires_doctor_approval": false,
    "rationale": "...",
    "disclaimers": ["Prana is a wellness education tool, not a medical diagnosis service."]
  }
]
```

---

## Disclaimers

Always append the following comment block to your output:

```
// Synthetic test data generated for development purposes only.
// Do not use for actual medical decisions. CareFlow is an educational
// triage tool, not a clinical diagnostic system.
```
