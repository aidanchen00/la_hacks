import { NextResponse } from "next/server";
import OpenAI from "openai";
import { insertRun, updateRunStatus, upsertRoutingDecision } from "@/lib/db";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ROUTING_SYSTEM = `You are the Prana Orchestrator. Analyze a wellness intake summary and return a JSON routing decision.

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

Return ONLY valid JSON:
{
  "urgency": "emergency|urgent|routine|wellness",
  "recommended_path": "doctor|pharmacy|mental_health|alt_medicine|self_care",
  "summary": "2-3 sentence wellness summary",
  "next_actions": ["action1", "action2", "action3"],
  "payment_required": false,
  "payment_amount_usd": 0.0,
  "requires_doctor_approval": false,
  "rationale": "Brief reasoning",
  "disclaimers": ["Disclaimer text"]
}`;

async function routeIntake(transcript: string, summary: string) {
  const userContent = `Intake transcript/symptoms: ${transcript}\n\nSummary: ${summary}`;
  try {
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: ROUTING_SYSTEM },
        { role: "user", content: userContent },
      ],
      temperature: 0,
      max_tokens: 600,
    });
    let raw = resp.choices[0].message.content ?? "{}";
    if (raw.startsWith("```")) {
      raw = raw.split("```")[1];
      if (raw.startsWith("json")) raw = raw.slice(4);
    }
    return JSON.parse(raw.trim());
  } catch {
    return {
      urgency: "wellness",
      recommended_path: "self_care",
      summary: summary || "Wellness intake recorded. Please review your dashboard for care options.",
      next_actions: ["Review your dashboard", "Speak with a healthcare professional if symptoms persist"],
      payment_required: false,
      payment_amount_usd: 0.0,
      requires_doctor_approval: false,
      rationale: "Fallback routing",
      disclaimers: ["Prana is a wellness education tool, not a medical diagnosis service."],
    };
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const transcript: string = body.transcript ?? "";
    const summary: string = body.summary ?? "";
    const nullifier_hash: string | undefined = body.nullifier_hash ?? undefined;
    const run_id = crypto.randomUUID();

    insertRun(run_id, transcript, summary, nullifier_hash);

    try {
      const decision = await routeIntake(transcript, summary);
      if (decision.urgency === "emergency") {
        const disclaimers: string[] = decision.disclaimers ?? [];
        if (!disclaimers.some((d: string) => d.includes("911") || d.toLowerCase().includes("emergency"))) {
          disclaimers.unshift("⚠️ EMERGENCY: Call 911 or go to the nearest emergency room immediately.");
        }
        decision.disclaimers = disclaimers;
      }
      upsertRoutingDecision({
        run_id,
        urgency: decision.urgency ?? "wellness",
        recommended_path: decision.recommended_path ?? "self_care",
        summary: decision.summary ?? null,
        next_actions: JSON.stringify(decision.next_actions ?? []),
        payment_required: decision.payment_required ? 1 : 0,
        payment_amount: decision.payment_amount_usd ?? 0,
        requires_doctor_approval: decision.requires_doctor_approval ? 1 : 0,
        rationale: decision.rationale ?? null,
        disclaimers: JSON.stringify(decision.disclaimers ?? []),
      });
      updateRunStatus(run_id, "routed");
    } catch {
      updateRunStatus(run_id, "error");
    }

    return NextResponse.json({ run_id });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
