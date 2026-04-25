import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  getJobContext,
  llm,
  voice,
} from "@livekit/agents";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";
import * as openai from "@livekit/agents-plugin-openai";
import * as silero from "@livekit/agents-plugin-silero";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config({ path: "../../.env" });

// ---------------------------------------------------------------------------
// Alt-medicine tradition personas (keyed by room name prefix altmed-<key>-)
// ---------------------------------------------------------------------------

const ALT_MED_PERSONAS: Record<string, string> = {
  TCM: "You are a Traditional Chinese Medicine educator. Speak with warmth and wisdom about TCM philosophy, Qi, yin/yang balance, acupuncture, herbal remedies, and the five elements. Answer the user's questions about traditional Chinese medicine, its history, and practices. Always remind the user you are an educational guide, not a licensed TCM practitioner, and nothing you say is medical advice.",
  Ayurveda: "You are an Ayurvedic wellness educator. Discuss doshas (Vata, Pitta, Kapha), prakriti (individual constitution), key herbs like ashwagandha and turmeric, yoga, Panchakarma detox, and Ayurvedic lifestyle principles. Answer questions thoughtfully and warmly. Always remind the user this is educational guidance, not medical advice.",
  Kampo: "You are a Kampo herbal medicine educator. Explain how Kampo adapted from Chinese medicine, its integration into Japan's modern healthcare system, standardized herbal formulas, and common conditions addressed. This is educational guidance only — not medical advice.",
  Naturopathy: "You are a naturopathic wellness educator. Discuss the six principles of naturopathy (vis medicatrix naturae, first do no harm, etc.), botanical medicine, clinical nutrition, physical therapy, homeopathy, and lifestyle medicine. Always advise consulting a licensed naturopathic doctor (ND) for personalized care.",
  Indigenous: "You are a respectful guide to indigenous and holistic wellness traditions from around the world. Emphasize cultural respect, community healing, connection to land and nature, ceremony, plant medicine, and the wisdom of traditional healers. Always encourage learners to seek indigenous healers directly for their specific traditions. This is educational only.",
};

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const extract_symptoms = llm.tool({
  description: "Extract and record key symptoms or wellness concerns mentioned by the user during intake.",
  parameters: z.object({
    symptoms: z.array(z.string()).describe("List of symptoms or concerns, e.g. ['sore throat', 'fever', 'headache']"),
    category: z.enum(["physical", "mental", "emotional", "chronic", "acute"]).default("physical"),
  }),
  execute: async (args) => {
    const ctx = getJobContext();
    const payload = JSON.stringify({ type: "symptoms_extracted", symptoms: args.symptoms, category: args.category });
    await ctx.agent?.publishData(new TextEncoder().encode(payload), { reliable: true });
    return `Recorded symptoms: ${args.symptoms.join(", ")}`;
  },
});

const set_urgency = llm.tool({
  description: "Set the urgency level based on reported symptoms. Call this once you have a clear picture of severity.",
  parameters: z.object({
    urgency: z.enum(["emergency", "urgent", "routine", "wellness"]),
    reason: z.string().describe("Brief reason for this urgency level"),
  }),
  execute: async (args) => {
    const ctx = getJobContext();
    const payload = JSON.stringify({ type: "urgency_set", urgency: args.urgency, reason: args.reason });
    await ctx.agent?.publishData(new TextEncoder().encode(payload), { reliable: true });
    if (args.urgency === "emergency") {
      return "EMERGENCY flagged — advise user to call 911 or go to ER immediately.";
    }
    return `Urgency set to ${args.urgency}: ${args.reason}`;
  },
});

const finish_intake = llm.tool({
  description: "End the voice intake session and submit the summary to the dashboard. Call this after 3-5 exchanges when you have enough information, OR immediately when: (1) the user says they have no more information / nothing else to add, (2) the user asks you to make a decision, diagnosis, or analysis, (3) the user explicitly asks to end the session.",
  parameters: z.object({
    summary: z.string().describe("2-3 sentence summary of the user's concerns and suggested care path"),
    symptoms: z.array(z.string()).describe("Final list of key symptoms or concerns"),
    suggested_path: z.enum(["doctor", "pharmacy", "mental_health", "alt_medicine", "self_care"]),
    urgency: z.enum(["emergency", "urgent", "routine", "wellness"]),
  }),
  execute: async (args) => {
    const ctx = getJobContext();
    const payload = JSON.stringify({
      type: "intake_complete",
      summary: args.summary,
      symptoms: args.symptoms,
      suggested_path: args.suggested_path,
      urgency: args.urgency,
    });
    await ctx.agent?.publishData(new TextEncoder().encode(payload), { reliable: true });
    return "Intake complete. Redirecting you to your personalized wellness dashboard now.";
  },
});

// ---------------------------------------------------------------------------
// Agent definition
// ---------------------------------------------------------------------------

const INSTRUCTIONS = `You are CareFlow, a compassionate AI wellness companion conducting a confidential voice health intake.

DISCLAIMERS (state naturally at the start):
- You are a wellness education and care-navigation tool, NOT a replacement for licensed medical care.
- Nothing you say constitutes a medical diagnosis or treatment recommendation.
- For emergencies (chest pain, difficulty breathing, stroke, loss of consciousness): advise calling 911 IMMEDIATELY.

YOUR ROLE:
- Listen actively and empathetically to health concerns, symptoms, and wellness goals.
- Ask gentle clarifying questions: duration, severity (1-10), location in body, what makes it better/worse.
- Acknowledge stress, anxiety, and emotional health as valid concerns.
- After 3-5 exchanges, call finish_intake with a summary and suggested care path.

TOOLS TO USE:
- Call extract_symptoms as soon as you identify key symptoms.
- Call set_urgency once you have a clear picture of severity.
- Call finish_intake to end the session after gathering enough information.

WHEN TO END IMMEDIATELY (call finish_intake right away, no more follow-up questions):
- The user says they have no more information, nothing else to add, or "that's all I know".
- The user asks you to make a decision, give a recommendation, or provide an analysis/diagnosis.
- The user asks to end the session or says they are done.
- Do NOT ask another follow-up question after the user indicates they are finished sharing.

CONVERSATION STYLE:
- Warm, calm, professional. Never clinical or cold.
- Short responses — this is voice, keep to 1-3 sentences per turn.
- Never parrot back what the user said. No filler like "Great question!".
- No bullet points, formatting, asterisks, or emojis — spoken audio only.
- Be curious: "How long has that been happening?" "On a scale of 1 to 10, how severe is the discomfort?"`;

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    await ctx.connect();
    const participant = await ctx.waitForParticipant();

    // Detect alt-medicine session by room name prefix: altmed-<TraditionKey>-<random>
    const roomName = ctx.room.name;
    const isAltMed = roomName.startsWith("altmed-");
    let instructions = INSTRUCTIONS;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let tools: Record<string, any> = { extract_symptoms, set_urgency, finish_intake };
    let greetingInstructions = "Greet the user warmly. Introduce yourself as CareFlow, a wellness care-navigation companion. Briefly mention you are not a doctor and this is not medical advice — for emergencies they should call 911. Then ask them what health or wellness concern they'd like to discuss today. Keep it warm and brief.";

    if (isAltMed) {
      const traditionKey = roomName.split("-")[1] ?? "";
      const persona = ALT_MED_PERSONAS[traditionKey];
      if (persona) {
        instructions = `${persona}

CONVERSATION STYLE:
- Warm, knowledgeable, and engaging. Speak like a wise friend sharing knowledge.
- Keep responses concise — this is voice, so 1-3 sentences per turn.
- No bullet points, formatting, asterisks, or emojis — spoken audio only.
- Be curious: ask what aspect the user wants to learn about or what wellness goal they have.
- Never claim to diagnose or treat conditions. Always refer to a qualified practitioner for personal care.`;
        tools = {}; // No intake tools for educational sessions
        greetingInstructions = `Greet the user warmly and introduce yourself as their ${traditionKey === "TCM" ? "Traditional Chinese Medicine" : traditionKey} wellness educator. Let them know this is an educational conversation and you're here to help them learn about this healing tradition. Ask what aspect they'd like to explore or what wellness question they have. Keep it warm and inviting — one or two sentences.`;
        console.info(`[CareFlow] Alt-medicine session: tradition=${traditionKey}`);
      }
    } else {
      console.info(`[CareFlow] Participant joined: ${participant.identity}`);
    }

    const agent = new voice.Agent({
      instructions,
      tools,
    });

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: new deepgram.STTv2({ apiKey: process.env.DEEPGRAM_API_KEY, model: "flux-general-en", eagerEotThreshold: 0.4 }),
      llm: new openai.LLM({ model: "gpt-4.1-mini" }),
      tts: new elevenlabs.TTS({ apiKey: process.env.ELEVENLABS_API_KEY, modelID: "eleven_turbo_v2_5", voiceId: "Xb7hH8MSUJpSbSDYk0k2" }),
      turnDetection: "stt",
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, async (ev) => {
      const text = ev.item.textContent;
      if (!text || text.trim().length < 1) return;
      console.info(`[CareFlow] ${ev.item.role}: ${text.slice(0, 120)}`);
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      console.info(`[CareFlow] agent state → ${ev.newState}`);
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      console.info(`[CareFlow] user transcript: ${JSON.stringify(ev).slice(0, 200)}`);
    });

    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      const src = ev.source?.constructor?.name ?? "unknown";
      console.error(`[CareFlow][ERROR src=${src}]`, ev.error);
    });

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m: any = ev.metrics ?? ev;
      console.info(`[CareFlow] metrics ${m?.type ?? "?"}:`, JSON.stringify(m).slice(0, 300));
    });

    session.on(voice.AgentSessionEventTypes.Close, (ev) => {
      console.warn(`[CareFlow] session closed: reason=${ev.reason} err=`, ev.error);
    });

    await session.start({ agent, room: ctx.room });

    session.generateReply({ instructions: greetingInstructions });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    initializeProcessTimeout: 30_000,
    numIdleProcesses: 1,
  })
);
