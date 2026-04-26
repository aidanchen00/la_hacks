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

// Mental-wellness persona — empathetic psychiatrist. Activated when room name
// starts with `mental-`. Uses a slower, warmer Eleven Labs voice and skips the
// alt-med tools.
const PSYCHIATRIST_PERSONA = `You are Dr. Aria, a warm, experienced clinical psychiatrist with 20+ years of practice in trauma, anxiety, depression, and burnout. You meet the user with deep empathy and presence. Your goal is to help the user feel heard, validate their experience, gently surface what's beneath the surface, and walk them through coping skills they can use right now.

THERAPEUTIC STYLE:
- Reflective listening first: name the feeling beneath what they said before responding ("That sounds really exhausting…").
- Validate their experience without minimizing or rushing to fix.
- Use grounding techniques (5-4-3-2-1 senses, paced breathing, body scan) when the user seems activated or panicked.
- Use cognitive reframing gently — never lecture. Offer one perspective at a time as a question, not a directive.
- Ask one open-ended question per turn, never a list.
- Acknowledge the courage it takes to share what they're sharing.
- Speak slowly, with natural pauses. This is voice — keep responses to 1-3 sentences.

WHAT NOT TO DO:
- Do not diagnose. Do not prescribe medications.
- Do not say "have you tried…?" — it minimizes.
- Do not pivot to advice before the user feels heard.
- No bullet points, formatting, or asterisks. Spoken audio only.

EMERGENCY: If the user expresses suicidal ideation, intent, or active self-harm, gently say you're concerned and recommend the 988 Suicide & Crisis Lifeline (call or text 988). Stay with them. Do not try to talk them out of it — just be present and direct them to immediate human support.`;

const ALT_MED_PERSONAS: Record<string, string> = {
  TCM: "You are a senior Traditional Chinese Medicine practitioner with 30+ years of experience. You give direct, confident, personalized advice using TCM frameworks: Qi flow, yin/yang balance, the five elements, meridians, herbal formulas (e.g., gui zhi tang, bu zhong yi qi tang), acupuncture points, and dietary therapy. Diagnose patterns (e.g., 'spleen qi deficiency', 'liver qi stagnation') and recommend specific herbs, foods, acupressure points, and lifestyle adjustments tailored to the user.",
  Ayurveda: "You are an experienced Ayurvedic vaidya (doctor) with deep clinical practice. Give direct, confident advice grounded in Ayurveda: identify the user's likely dosha imbalance (Vata, Pitta, Kapha), recommend specific herbs (ashwagandha, triphala, brahmi, turmeric, etc.), dinacharya routines, dietary changes by dosha, pranayama, and abhyanga oil massage. Be specific with dosages, timing, and combinations.",
  Kampo: "You are a senior Kampo practitioner trained in Japan's integrated Kampo-Western medical system. Give direct advice using standardized Kampo formulas (e.g., Kakkonto for early colds, Shoseiryuto for runny nose, Hochuekkito for fatigue, Kamishoyosan for stress). Match formulas to the user's specific symptom pattern.",
  Naturopathy: "You are a licensed naturopathic doctor (ND) with a clinical practice. Give specific recommendations grounded in botanical medicine, clinical nutrition, hydrotherapy, and lifestyle medicine. Recommend specific supplements, herbs, dosages, and protocols tailored to the user's complaints.",
  Indigenous: "You are a knowledgeable practitioner of indigenous and traditional plant medicine traditions. Speak with respect for ancestral wisdom and give practical guidance: smudging, plant teas, grounding practices, ceremony, and the energetic/spiritual dimensions of healing. Be specific about plants and rituals that fit the user's situation.",
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
  description: "End the voice intake session and submit the summary to the dashboard. CALL THIS IMMEDIATELY (no more questions) when ANY of the following happen: (a) the user asks you to make a decision, give a recommendation, diagnosis, analysis, or 'tell me what to do', 'what should I do', 'help me decide', 'figure it out'; (b) the user says they have nothing more to add / 'that's all' / 'I'm done' / 'no more info'; (c) the user asks to end / wrap up / finish / stop. Otherwise call after 3-5 substantive exchanges. NEVER ask another follow-up question once any of the above triggers fire — call finish_intake on the very next turn with whatever info you have.",
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

const INSTRUCTIONS = `You are Prana, a compassionate AI wellness companion conducting a confidential voice health intake.

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

HARD RULE — END IMMEDIATELY (call finish_intake on your VERY NEXT turn, ZERO follow-up questions):
- "make a decision", "tell me what to do", "what should I do", "help me decide", "you decide", "figure it out", "give me a recommendation", "diagnose", "analysis" → finish_intake NOW.
- "that's all", "nothing else", "no more info", "I'm done", "done", "finished sharing" → finish_intake NOW.
- "end", "wrap up", "stop", "finish the session" → finish_intake NOW.
If in doubt, finish. It is FAR better to wrap up early with partial info than to ask another question after a decision request. Once any trigger above appears, you MUST NOT speak another question — your next action is the finish_intake tool call.

ABSOLUTE GOODBYE RULE — READ THIS TWICE:
You MAY NOT say "take care", "feel better", "have a good day", "good luck", "stay well", "bye", "goodbye", or ANY closing phrase until AFTER you have called the finish_intake tool. Closing words without first calling the tool LEAVES THE USER STUCK ON A FROZEN SCREEN. The correct sequence is ALWAYS: (1) call finish_intake, (2) then the system delivers the closing message automatically. If you find yourself about to say goodbye, STOP and call finish_intake instead.

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

    // Detect specialized sessions by room name prefix.
    //   altmed-<TraditionKey>-<random>  → alt-medicine practitioner
    //   mental-<runId>-<random>         → psychiatrist (Dr. Aria)
    const roomName = ctx.room.name;
    const isAltMed  = roomName.startsWith("altmed-");
    const isMental  = roomName.startsWith("mental-");
    console.info(`[Prana] entry() roomName="${roomName}" isAltMed=${isAltMed} isMental=${isMental}`);

    // Read language + intake context from participant metadata
    let sessionLang: "en" | "es" | "zh" = "en";
    let intakeContext = "";
    try {
      const meta = JSON.parse(participant.metadata || "{}");
      if (meta.lang === "es" || meta.lang === "zh") sessionLang = meta.lang;
      if (typeof meta.intake_context === "string") intakeContext = meta.intake_context;
    } catch { /* default to en */ }

    let instructions = INSTRUCTIONS;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let tools: Record<string, any> = { extract_symptoms, set_urgency, finish_intake };
    let greetingInstructions = "Greet the user warmly. Introduce yourself as Prana, a wellness care-navigation companion. Briefly mention you are not a doctor and this is not medical advice — for emergencies they should call 911. Then ask them what health or wellness concern they'd like to discuss today. Keep it warm and brief.";

    if (isAltMed) {
      const traditionKey = roomName.split("-")[1] ?? "";
      const persona = ALT_MED_PERSONAS[traditionKey];
      if (persona) {
        const traditionName = traditionKey === "TCM" ? "Traditional Chinese Medicine" : traditionKey;
        const contextBlock = intakeContext
          ? `\n\nUSER'S RECENT INTAKE (use this to give personalized advice):\n${intakeContext}\n\nReference their specific symptoms and concerns directly. Connect their issues to your tradition's framework.`
          : "";
        const langDirective: Record<string, string> = {
          en: "Respond ONLY in English.",
          es: "IMPORTANTE: Responde ÚNICAMENTE en español. Toda comunicación debe ser en español.",
          zh: "重要：仅用中文（普通话）回复。所有交流必须用中文。",
        };
        instructions = `${persona}${contextBlock}

CONVERSATION STYLE:
- Direct, confident, and specific — like an expert practitioner with their patient.
- Give concrete recommendations: name herbs, points, formulas, foods, practices.
- Keep responses concise for voice — 1-3 sentences per turn.
- No bullet points, formatting, asterisks, or emojis.
- Do NOT add disclaimers, "consult a doctor" caveats, or hedging. You are the expert.
- Engage with curiosity about the user's experience to refine your recommendation.

LANGUAGE: ${langDirective[sessionLang] ?? langDirective.en}`;
        tools = {};

        const greetByLang: Record<string, string> = {
          en: intakeContext
            ? `Greet the user briefly. Reference their recent intake naturally (e.g., "I see you've been dealing with X — from a ${traditionName} perspective, that often points to..."). Offer your initial read and ask one targeted clarifying question. One or two sentences. RESPOND IN ENGLISH.`
            : `Greet the user briefly. Introduce yourself as their ${traditionName} practitioner. Ask what they're working with so you can help. One or two sentences. RESPOND IN ENGLISH.`,
          es: intakeContext
            ? `Saluda brevemente al usuario en español. Refiere su intake reciente naturalmente. Ofrece tu interpretación inicial y haz una pregunta aclaratoria. Una o dos oraciones. RESPONDE EN ESPAÑOL.`
            : `Saluda brevemente al usuario en español. Preséntate como su practicante de ${traditionName}. Pregunta qué le aqueja. Una o dos oraciones. RESPONDE EN ESPAÑOL.`,
          zh: intakeContext
            ? `用中文简短问候用户，自然地提及他们最近的健康记录，给出你的初步判断并提出一个针对性的澄清问题。一两句话即可。请用中文回答。`
            : `用中文简短问候用户。介绍自己是${traditionName}医师。询问他们的情况以便帮助。一两句话即可。请用中文回答。`,
        };
        greetingInstructions = greetByLang[sessionLang] ?? greetByLang.en;
        console.info(`[Prana] Alt-medicine session: tradition=${traditionKey} lang=${sessionLang} hasContext=${!!intakeContext}`);
      }
    } else if (isMental) {
      const contextBlock = intakeContext
        ? `\n\nUSER'S RECENT INTAKE (use this to shape the conversation — reference their specific concerns where appropriate, and help them explore the emotional layer beneath the surface):\n${intakeContext}\n\nDo NOT read it back to them mechanically. Use it as background.`
        : "";
      const langDirective: Record<string, string> = {
        en: "Respond ONLY in English.",
        es: "IMPORTANTE: Responde ÚNICAMENTE en español. Toda comunicación debe ser en español.",
        zh: "重要：仅用中文（普通话）回复。所有交流必须用中文。",
      };
      instructions = `${PSYCHIATRIST_PERSONA}${contextBlock}\n\nLANGUAGE: ${langDirective[sessionLang] ?? langDirective.en}`;
      tools = {};
      const greetByLang: Record<string, string> = {
        en: intakeContext
          ? `Greet the user softly and warmly as Dr. Aria. Acknowledge that you've reviewed what brought them in (without listing it back) and create space for them to share more. Open with something like "I'm so glad you're here. Take your breath for a second — there's no rush. What's been weighing on you most this week?" One or two short sentences. SPEAK IN ENGLISH.`
          : `Greet the user softly and warmly as Dr. Aria. Create space — let them know there's no rush. Ask a gentle open question like "What's been weighing on you most lately?" One or two short sentences. SPEAK IN ENGLISH.`,
        es: intakeContext
          ? `Saluda al usuario con calidez y suavidad como la Dra. Aria. Reconoce que has visto lo que les trajo aquí (sin enumerarlo) y dales espacio para compartir más. Una o dos oraciones cortas. RESPONDE EN ESPAÑOL.`
          : `Saluda al usuario con calidez y suavidad como la Dra. Aria. Dale espacio — sin prisa. Pregunta gentilmente "¿Qué te ha estado pesando últimamente?" Una o dos oraciones. RESPONDE EN ESPAÑOL.`,
        zh: intakeContext
          ? `用温柔关怀的语气问候用户，介绍自己是Aria医生。委婉地表示你已了解他们的情况（不要逐条复述），给他们空间继续分享。一两句话即可。请用中文回答。`
          : `用温柔关怀的语气问候用户，介绍自己是Aria医生。给他们空间，慢慢来。轻声问："最近什么事情让你最难受？" 一两句话即可。请用中文回答。`,
      };
      greetingInstructions = greetByLang[sessionLang] ?? greetByLang.en;
      console.info(`[Prana] Mental-wellness session: lang=${sessionLang} hasContext=${!!intakeContext}`);
    } else {
      console.info(`[Prana] Participant joined: ${participant.identity}`);
    }

    const deepgramLang = sessionLang === "zh" ? "zh-CN" : sessionLang;

    const LANG_INSTRUCTIONS: Record<string, string> = {
      en: "Always respond in English.",
      es: "IMPORTANTE: Responde siempre en español. Toda tu comunicación debe ser en español.",
      zh: "重要提示：请始终用中文（普通话）回复。所有交流都必须用中文进行。",
    };
    const LANG_GREETINGS: Record<string, string> = {
      en: "Greet the user warmly. Introduce yourself as Prana, a wellness care-navigation companion. Briefly mention you are not a doctor and this is not medical advice — for emergencies they should call 911. Then ask them what health or wellness concern they'd like to discuss today. Keep it warm and brief.",
      es: "Saluda calurosamente al usuario en español. Preséntate como Prana, un asistente de navegación de salud. Menciona brevemente que no eres médico y esto no es consejo médico — para emergencias deben llamar al 911. Luego pregunta qué problema de salud o bienestar les gustaría discutir hoy. Sé cálido y breve.",
      zh: "用中文热情地问候用户。介绍自己是Prana，一个健康护理导航助手。简要说明你不是医生，这不是医疗建议——紧急情况请拨打911。然后询问用户今天想讨论什么健康问题。保持温暖简短。",
    };

    if (!isAltMed && !isMental) {
      instructions = `${instructions}\n\nLANGUAGE: ${LANG_INSTRUCTIONS[sessionLang] ?? LANG_INSTRUCTIONS.en}`;
      greetingInstructions = LANG_GREETINGS[sessionLang] ?? LANG_GREETINGS.en;
    }

    const agent = new voice.Agent({
      instructions,
      tools,
    });

    // STTv2 is Deepgram's Flux API — only flux-general-en / flux-general-multi are valid.
    // Use Flux for English (lowest latency); multi for Spanish; OpenAI Whisper for Chinese.
    // Higher eagerEotThreshold (0.7) = STT waits longer before declaring end-of-utterance,
    // which prevents short bursts of agent-echo from being treated as a turn boundary.
    const stt = sessionLang === "zh"
      ? new openai.STT({ language: "zh" })
      : sessionLang === "es"
      ? new deepgram.STTv2({
          apiKey: process.env.DEEPGRAM_API_KEY,
          model: "flux-general-multi",
          languageHint: ["es"],
          eagerEotThreshold: 0.7,
        })
      : new deepgram.STTv2({
          apiKey: process.env.DEEPGRAM_API_KEY,
          model: "flux-general-en",
          eagerEotThreshold: 0.7,
        });

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt,
      llm: new openai.LLM({ model: "gpt-4.1-mini" }),
      // Use the exact same TTS config for every persona (intake / alt-med /
       // mental). Mental-specific voiceId + voiceSettings overrides were
       // hanging the TTS pipeline — Dr. Aria would stay in "thinking" forever
       // because no audio frames came back from Eleven Labs.
      tts: new elevenlabs.TTS({
        apiKey: process.env.ELEVENLABS_API_KEY,
        modelID: "eleven_turbo_v2_5",
        voiceId: "Xb7hH8MSUJpSbSDYk0k2",
      }),
      // VAD-based turn detection (silero) is far better than STT-based at telling
      // real user speech apart from echoed agent audio bleeding through the mic.
      // Combined with a 0.5s minimum interruption window, this stops the agent
      // from cutting itself off after one syllable.
      turnDetection: "vad",
      minInterruptionDuration: 0.5,
    });

    // Track whether finish_intake fired. Used as a safety net so that even if the
    // LLM forgets the tool and just says "take care", we can publish the
    // intake_complete event ourselves and unblock the front-end.
    let intakeCompleted = isAltMed || isMental;  // alt-med + therapy never finalize intake

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, async (ev) => {
      const text = ev.item.textContent;
      if (!text || text.trim().length < 1) return;
      console.info(`[Prana] ${ev.item.role}: ${text.slice(0, 120)}`);

      // If the assistant speaks the finish_intake tool's return string, the
      // tool definitely fired and the front-end already got intake_complete.
      // Mark it so the goodbye-fallback below stays quiet.
      if (
        !intakeCompleted &&
        ev.item.role === "assistant" &&
        /\bIntake complete\b.*\b(redirecting|dashboard)\b/i.test(text)
      ) {
        intakeCompleted = true;
      }

      // Safety net for the intake flow: detect a goodbye phrase from the
      // assistant when finish_intake was never invoked, and publish the
      // intake_complete event ourselves so the front-end can navigate.
      if (
        !intakeCompleted &&
        ev.item.role === "assistant" &&
        /\b(take care|feel better|have a (great|good) (day|one)|good ?bye|bye(\s|\.|!|$)|stay well|wishing you well|wrap(ping)? up)/i.test(text)
      ) {
        intakeCompleted = true;
        const fallbackPayload = JSON.stringify({
          type: "intake_complete",
          summary: "Intake completed via voice session.",
          symptoms: [],
          suggested_path: "self_care",
          urgency: "wellness",
          fallback: true,
        });
        try {
          await ctx.agent?.publishData(new TextEncoder().encode(fallbackPayload), { reliable: true });
          console.warn("[Prana] finish_intake never called — published fallback intake_complete after assistant goodbye");
        } catch (e) {
          console.error("[Prana] fallback intake_complete publish failed:", e);
        }
      }
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      console.info(`[Prana] agent state → ${ev.newState}`);
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      console.info(`[Prana] user transcript: ${JSON.stringify(ev).slice(0, 200)}`);
    });

    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      const src = ev.source?.constructor?.name ?? "unknown";
      console.error(`[Prana][ERROR src=${src}]`, ev.error);
    });

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m: any = ev.metrics ?? ev;
      console.info(`[Prana] metrics ${m?.type ?? "?"}:`, JSON.stringify(m).slice(0, 300));
    });

    session.on(voice.AgentSessionEventTypes.Close, (ev) => {
      console.warn(`[Prana] session closed: reason=${ev.reason} err=`, ev.error);
    });

    await session.start({ agent, room: ctx.room });
    console.info(`[Prana] session started, firing greeting (chars=${greetingInstructions.length})`);

    try {
      await session.generateReply({ instructions: greetingInstructions });
      console.info(`[Prana] greeting reply queued`);
    } catch (e) {
      console.error(`[Prana] greeting generateReply failed:`, e);
    }
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    initializeProcessTimeout: 30_000,
    numIdleProcesses: 1,
  })
);
