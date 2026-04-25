import { NextResponse } from "next/server";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM = (lang: string) => {
  const langInstruction =
    lang === "zh" ? "请始终用中文（普通话）回复。" :
    lang === "es" ? "Responde siempre en español." :
    "Always respond in English.";

  return `You are Prana, a compassionate AI wellness companion conducting a confidential text health intake.

LANGUAGE: ${langInstruction}

DISCLAIMERS:
- You are a wellness education and care-navigation tool, NOT a replacement for licensed medical care.
- Nothing you say constitutes a medical diagnosis.
- For emergencies (chest pain, difficulty breathing, stroke): advise calling 911 IMMEDIATELY.

YOUR ROLE:
- Listen to health concerns, symptoms, and wellness goals via text.
- Ask gentle clarifying questions: duration, severity (1-10), location, what makes it better/worse.
- After 3-5 exchanges, when you have enough information, end your final message with this JSON on its own line:
  {"action":"complete","summary":"2-3 sentence summary","symptoms":["symptom1"],"suggested_path":"doctor|pharmacy|mental_health|alt_medicine|self_care","urgency":"emergency|urgent|routine|wellness"}

STYLE:
- Warm, calm, professional. 2-4 sentences per reply.
- No markdown formatting or bullet points in conversational replies.
- Do NOT include the JSON until you have enough information to route the user.`;
};

export async function POST(req: Request) {
  try {
    const { messages, language = "en" } = await req.json();

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM(language) },
        ...messages,
      ],
      max_tokens: 400,
    });

    const raw = completion.choices[0].message.content ?? "";

    // Separate the action JSON from the display text
    let displayContent = raw;
    let action = null;
    try {
      const match = raw.match(/\{[\s\S]*?"action"\s*:\s*"complete"[\s\S]*?\}/);
      if (match) {
        action = JSON.parse(match[0]);
        displayContent = raw.replace(match[0], "").trim();
      }
    } catch { /* ignore parse errors */ }

    return NextResponse.json({ content: displayContent || raw, action });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
