"use client";

import { useEffect, useRef, useState, useCallback, useMemo, Suspense } from "react";
import { TokenSource, MediaDeviceFailure } from "livekit-client";
import {
  useSession,
  SessionProvider,
  useAgent,
  BarVisualizer,
  RoomAudioRenderer,
  TrackToggle,
  DisconnectButton,
  useDataChannel,
  SessionEvent,
  useEvents,
} from "@livekit/components-react";
import { Track } from "livekit-client";
import "@livekit/components-styles";
import { postIntake, listRuns, type RunSummary } from "@/lib/api";
import { useRouter, useSearchParams } from "next/navigation";
import { motion } from "motion/react";
import { Clock, Globe, Settings, Check } from "lucide-react";

type Lang = "en" | "es" | "zh";

const LANG_LABELS: Record<Lang, string> = { en: "EN", es: "ES", zh: "中文" };

const TRANSLATIONS = {
  en: {
    history: "History",
    tagline: "Voice-first · Powered by AI agents",
    startTalking: "Start talking",
    typeSymptoms: "Or type your symptoms",
    previewDemo: "Preview demo →",
    disclaimer: "Prana is a wellness education tool — not a substitute for licensed medical care. For emergencies, call 911.",
    speakNow: "Speak now — I'm listening…",
    endSession: "End Session",
    typePlaceholder: "Type your symptoms…",
    send: "Send",
  },
  es: {
    history: "Historial",
    tagline: "Voz primero · Impulsado por agentes de IA",
    startTalking: "Empieza a hablar",
    typeSymptoms: "O escribe tus síntomas",
    previewDemo: "Vista previa →",
    disclaimer: "Prana es una herramienta educativa — no sustituye la atención médica. Para emergencias, llama al 911.",
    speakNow: "Habla ahora — te estoy escuchando…",
    endSession: "Terminar sesión",
    typePlaceholder: "Escribe tus síntomas…",
    send: "Enviar",
  },
  zh: {
    history: "历史记录",
    tagline: "语音优先 · 由 AI 智能体提供支持",
    startTalking: "开始说话",
    typeSymptoms: "或输入您的症状",
    previewDemo: "预览演示 →",
    disclaimer: "Prana 是健康教育工具，不能替代专业医疗建议。紧急情况请拨打 911。",
    speakNow: "请说话 — 我正在聆听…",
    endSession: "结束会话",
    typePlaceholder: "输入您的症状…",
    send: "发送",
  },
} as const;

type Translations = typeof TRANSLATIONS[Lang];

const URGENCY_COLORS: Record<string, string> = {
  emergency: "#DC2626", urgent: "#EA580C", routine: "#D97706", wellness: "#16A34A",
};
const PATH_LABELS: Record<string, string> = {
  doctor: "Doctor", pharmacy: "Pharmacy", mental_health: "Mental Wellness",
  alt_medicine: "Alt. Medicine", self_care: "Self-Care",
};

function RecentSessions({ onClose }: { onClose: () => void }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const router = useRouter();

  useEffect(() => {
    listRuns()
      .then((data) => { if (Array.isArray(data)) setRuns(data); })
      .catch(() => {});
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col h-full bg-[#F4F1EA]"
    >
      <div className="px-4 sm:px-6 pt-6 pb-4 flex items-center gap-3">
        <button
          onClick={onClose}
          className="text-[#1F3A2E] text-sm font-medium hover:opacity-70 transition-opacity min-h-[44px] flex items-center"
        >
          ← Back
        </button>
        <h2 className="font-serif text-[#1F3A2E] text-xl font-medium">Your History</h2>
        {runs.length > 0 && (
          <span className="ml-auto text-xs text-[#6B7280]">
            {runs.length} classified intake{runs.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 pb-8">
        {runs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-[#6B7280] text-base">No sessions yet.</p>
            <p className="text-[#6B7280] text-sm mt-1">Start a conversation to see your history here.</p>
          </div>
        ) : (
          <div className="space-y-3 max-w-md mx-auto">
            {runs.map((run) => {
              const label = run.rd_summary ?? run.intake_summary ?? run.instruction ?? "Intake session";
              const pathLabel = PATH_LABELS[run.recommended_path ?? ""] ?? "Pending";
              const color = URGENCY_COLORS[run.urgency ?? ""] ?? "#6B7280";
              const date = new Date(run.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
              return (
                <button
                  key={run.id}
                  onClick={() => router.push(`/dashboard?run_id=${run.id}`)}
                  className="w-full text-left bg-[#EFEAE0] rounded-2xl p-4 border border-[#1F3A2E]/10 hover:border-[#1F3A2E]/30 transition-colors min-h-[72px]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-[#3D3D3D] text-sm leading-relaxed flex-1 line-clamp-2">
                      {label.length > 80 ? label.slice(0, 80) + "…" : label}
                    </p>
                    {run.urgency && (
                      <span
                        className="text-xs font-bold px-2.5 py-1 rounded-full whitespace-nowrap flex-shrink-0"
                        style={{ color, background: color + "20" }}
                      >
                        {run.urgency}
                      </span>
                    )}
                  </div>
                  <p className="text-[#6B7280] text-xs mt-2">
                    {date} · {pathLabel}
                  </p>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </motion.div>
  );
}

interface IntakeData {
  summary?: string;
  symptoms?: string[];
  suggested_path?: string;
  urgency?: string;
}

function RoomView({ onIntakeComplete, t }: { onIntakeComplete: (data: IntakeData) => void; t: Translations }) {
  const agent = useAgent();
  const intakeRef = useRef<IntakeData>({});
  const completedRef = useRef(false);
  const [liveTranscript, setLiveTranscript] = useState("");

  const onData = useCallback((msg: { payload: Uint8Array }) => {
    try {
      const text = new TextDecoder().decode(msg.payload);
      const data = JSON.parse(text);
      if (data.type === "transcript_delta") {
        setLiveTranscript((prev) => prev + (data.text ?? ""));
      } else if (data.type === "symptoms_extracted") {
        intakeRef.current.symptoms = data.symptoms;
      } else if (data.type === "urgency_set") {
        intakeRef.current.urgency = data.urgency;
      } else if (data.type === "intake_complete") {
        if (completedRef.current) return; // belt-and-suspenders: ignore duplicates
        completedRef.current = true;
        intakeRef.current = { ...intakeRef.current, ...data };
        onIntakeComplete(intakeRef.current);
      }
    } catch { /* ignore malformed */ }
  }, [onIntakeComplete]);

  useDataChannel(onData);

  const isListening = agent.state === "listening";
  const isSpeaking = agent.state === "speaking";

  return (
    <div className="flex flex-col h-full bg-[#F4F1EA] items-center justify-center px-4 sm:px-6 py-6 sm:py-8">

      {/* Status label */}
      <div className="flex items-center gap-2 mb-4 sm:mb-8">
        <motion.div
          className="w-1.5 h-1.5 rounded-full"
          style={{ backgroundColor: isListening ? "#1F3A2E" : isSpeaking ? "#D97706" : "#6B7280" }}
          animate={{ opacity: [1, 0.3, 1] }}
          transition={{ duration: 2, repeat: Infinity }}
        />
        <span className="text-[#1F3A2E] text-xs uppercase tracking-wider font-medium">
          {agent.state ?? "connecting"}
        </span>
      </div>

      {/* Orb with BarVisualizer — smaller on mobile */}
      <motion.div
        className="relative w-56 h-56 sm:w-72 sm:h-72"
        animate={{ scale: isListening ? 1.18 : 1 }}
        transition={{ duration: 0.4, ease: "easeInOut" }}
      >
        {/* Outer glow */}
        <motion.div
          className="absolute inset-0 rounded-full blur-3xl"
          style={{ backgroundColor: "rgba(31,58,46,0.10)" }}
          animate={{
            opacity: isListening ? [0.5, 0.8, 0.5] : [0.3, 0.5, 0.3],
            scale: isListening ? [1, 1.15, 1] : [1, 1.05, 1],
          }}
          transition={{ duration: isListening ? 1.2 : 3, repeat: Infinity, ease: "easeInOut" }}
        />
        {/* Main orb */}
        <motion.div
          className="absolute inset-8 sm:inset-12 rounded-full flex items-center justify-center overflow-hidden shadow-2xl"
          style={{ background: "radial-gradient(circle at 40% 40%, #2A4D3D, #1F3A2E)" }}
          animate={{ opacity: [0.9, 1, 0.9] }}
          transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
        >
          <BarVisualizer
            state={agent.state}
            barCount={9}
            track={agent.microphoneTrack}
            style={{ width: "60%", height: "40%" }}
          />
        </motion.div>
        {/* Inner glow */}
        <motion.div
          className="absolute inset-12 sm:inset-16 rounded-full pointer-events-none blur-2xl"
          style={{ backgroundColor: "rgba(42,77,61,0.40)" }}
          animate={{ opacity: isListening ? [0.7, 1, 0.7] : [0.5, 0.8, 0.5] }}
          transition={{ duration: isListening ? 1.2 : 3, repeat: Infinity, ease: "easeInOut" }}
        />
      </motion.div>

      {/* Transcript + controls */}
      <div className="mt-6 sm:mt-10 w-full max-w-md space-y-4">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-[#EFEAE0] rounded-3xl p-5 sm:p-6"
        >
          <p className="text-[#3D3D3D] text-base leading-relaxed min-h-[60px]">
            {liveTranscript || (
              <span className="text-[#6B7280]">{t.speakNow}</span>
            )}
            <motion.span
              className="inline-block w-0.5 h-4 bg-[#1F3A2E] ml-1 align-middle"
              animate={{ opacity: [1, 0] }}
              transition={{ duration: 0.8, repeat: Infinity }}
            />
          </p>
        </motion.div>

        <div className="flex items-center justify-center gap-3" data-lk-theme="default">
          <TrackToggle
            source={Track.Source.Microphone}
            style={{
              padding: "12px 22px", borderRadius: "9999px",
              background: "rgba(31,58,46,0.08)", color: "#1F3A2E",
              fontSize: 14, cursor: "pointer", border: "1px solid rgba(31,58,46,0.2)",
              fontFamily: "inherit", minHeight: 44,
            }}
          />
          <DisconnectButton style={{
            padding: "12px 22px", borderRadius: "9999px",
            background: "rgba(220,38,38,0.08)", color: "#DC2626",
            fontSize: 14, cursor: "pointer", border: "1px solid rgba(220,38,38,0.2)",
            fontFamily: "inherit", minHeight: 44,
          }}>
            {t.endSession}
          </DisconnectButton>
        </div>
      </div>

      <RoomAudioRenderer />
    </div>
  );
}

function TextChatView({
  onIntakeComplete, t, language,
}: {
  onIntakeComplete: (data: IntakeData) => void;
  t: Translations;
  language: string;
}) {
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const onIntakeCompleteRef = useRef(onIntakeComplete);
  onIntakeCompleteRef.current = onIntakeComplete;
  const doneRef = useRef(false);

  const callApi = useCallback(async (msgs: { role: "user" | "assistant"; content: string }[]) => {
    setThinking(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: msgs, language }),
      });
      const data = await res.json();
      if (data.content) {
        setMessages((prev) => [...prev, { role: "assistant", content: data.content }]);
      }
      if (data.action?.action === "complete" && !doneRef.current) {
        doneRef.current = true;
        onIntakeCompleteRef.current({
          summary: data.action.summary,
          symptoms: data.action.symptoms,
          suggested_path: data.action.suggested_path,
          urgency: data.action.urgency,
        });
      }
    } catch { /* ignore */ }
    finally { setThinking(false); }
  }, [language]);

  // Greeting fires exactly once on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { callApi([]); }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking]);

  const handleSend = async () => {
    if (!input.trim() || thinking) return;
    const userMsg = { role: "user" as const, content: input.trim() };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput("");
    await callApi(next);
  };

  return (
    <div className="flex flex-col h-full bg-[#F4F1EA] px-4 sm:px-6 py-6 sm:py-8">
      {/* Chat area */}
      <div className="w-full max-w-md mx-auto flex flex-col gap-3 flex-1 min-h-0">
        <div className="flex-1 overflow-y-auto space-y-3 pr-1">
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`rounded-2xl px-4 py-3 text-base leading-relaxed max-w-[85%] ${
                msg.role === "user"
                  ? "bg-[#1F3A2E] text-white"
                  : "bg-[#EFEAE0] text-[#3D3D3D]"
              }`}>
                {msg.content}
              </div>
            </div>
          ))}
          {thinking && (
            <div className="flex justify-start">
              <div className="bg-[#EFEAE0] rounded-2xl px-4 py-3">
                <motion.span
                  className="text-[#6B7280] text-base"
                  animate={{ opacity: [0.4, 1, 0.4] }}
                  transition={{ duration: 1, repeat: Infinity }}
                >
                  ···
                </motion.span>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input row */}
        <div className="flex gap-2 pt-2 items-end">
          <textarea
            value={input}
            rows={1}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={t.typePlaceholder}
            className="flex-1 bg-[#EFEAE0] rounded-2xl px-4 py-3 text-[#3D3D3D] outline-none border border-[#1F3A2E]/10 focus:border-[#1F3A2E]/30 transition-colors resize-none overflow-hidden max-h-40"
            style={{ lineHeight: "1.5", fontSize: 16 }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || thinking}
            className="bg-[#1F3A2E] text-white rounded-full px-5 font-medium hover:bg-[#2A4D3D] transition-colors disabled:opacity-40 shrink-0 min-h-[48px]"
            style={{ fontSize: 15 }}
          >
            {t.send}
          </button>
        </div>
      </div>
    </div>
  );
}

function VoiceIntake({ onShowHistory, language, onLanguageChange }: {
  onShowHistory: () => void;
  language: Lang;
  onLanguageChange: (l: Lang) => void;
}) {
  const [langOpen, setLangOpen] = useState(false);

  // tokenSource is stable per mount — component remounts (via key) when language changes
  const tokenSource = useMemo(
    () => TokenSource.endpoint(`/api/token?lang=${language}`),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const t = TRANSLATIONS[language];
  const session = useSession(tokenSource);
  const [started, setStarted] = useState(false);
  const [textMode, setTextMode] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();

  const handleIntakeComplete = useCallback(async (data: IntakeData) => {
    setSubmitting(true);
    try {
      const { run_id } = await postIntake({
        transcript: data.symptoms?.join(", ") ?? "",
        summary: data.summary ?? "Intake completed via voice session.",
        voice_session_id: (session as { roomName?: string }).roomName ?? undefined,
      });

      fetch("/api/composio/sheets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_id, timestamp: new Date().toISOString(),
          transcript: data.symptoms?.join(", "),
          summary: data.summary, urgency: data.urgency,
          recommended_path: data.suggested_path,
          symptoms: data.symptoms?.join(", "),
        }),
      }).catch(() => {});

      if (data.summary) {
        const emailBody = `
          <h2>Your Prana Wellness Intake</h2>
          <p><strong>Summary:</strong> ${data.summary}</p>
          <p><strong>Concerns noted:</strong> ${data.symptoms?.join(", ") ?? "See dashboard"}</p>
          <p><strong>Suggested path:</strong> ${data.suggested_path ?? "review dashboard"}</p>
          <p><strong>Urgency:</strong> ${data.urgency ?? "wellness"}</p>
          <hr/>
          <p><em>Prana is a wellness education and care-navigation tool. This is not a medical diagnosis. Please consult a licensed healthcare professional for medical advice.</em></p>
        `;
        fetch("/api/composio/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subject: "Your Prana Wellness Intake Summary", body: emailBody }),
        }).catch(() => {});

        fetch("/api/twilio/sms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            run_id,
            summary: data.summary,
            symptoms: data.symptoms?.join(", "),
            urgency: data.urgency,
            suggested_path: data.suggested_path,
          }),
        }).catch(() => {});
      }

      await session.end().catch(() => {});
      router.push(`/dashboard?run_id=${run_id}`);
    } catch (e) {
      console.error("Failed to submit intake:", e);
      setSubmitting(false);
    }
  }, [session, router]);

  useEffect(() => {
    if (started && !textMode) session.start().catch(console.error);
    else session.end().catch(() => {});
  }, [started, textMode, session]);

  useEvents(session, SessionEvent.MediaDevicesError, (error) => {
    const failure = MediaDeviceFailure.getFailure(error);
    console.error("Media device failure:", failure);
    alert("Microphone access required. Please grant mic permissions and reload.");
  }, []);

  if (submitting) {
    return (
      <div className="flex flex-col min-h-screen items-center justify-center bg-[#F4F1EA]">
        <motion.div
          animate={{ opacity: [0.5, 1, 0.5] }}
          transition={{ duration: 2, repeat: Infinity }}
          className="font-serif text-[#1F3A2E] text-2xl font-medium text-center px-8"
        >
          Saving your intake summary…
        </motion.div>
      </div>
    );
  }

  if (started && textMode) {
    return <TextChatView onIntakeComplete={handleIntakeComplete} t={t} language={language} />;
  }

  if (started) {
    return (
      <SessionProvider session={session}>
        <RoomView onIntakeComplete={handleIntakeComplete} t={t} />
      </SessionProvider>
    );
  }

  return (
    <SessionProvider session={session}>
      <div className="flex flex-col min-h-screen bg-[#F4F1EA]">

        {/* Top bar */}
        <nav className="flex items-center justify-end px-4 sm:px-6 md:px-10 pt-5 pb-3">
          <div className="flex items-center gap-2">
            <button
              onClick={onShowHistory}
              aria-label="View history"
              className="flex items-center gap-1.5 px-3 py-2.5 rounded-full border border-[#1F3A2E]/20 text-[#3D3D3D] text-sm hover:border-[#1F3A2E]/40 transition-colors min-h-[44px]"
            >
              <Clock className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t.history}</span>
            </button>

            {/* Language dropdown */}
            <div className="relative">
              <button
                onClick={() => setLangOpen((o) => !o)}
                aria-label="Select language"
                className="flex items-center gap-1 px-3 py-2.5 rounded-full border border-[#1F3A2E]/20 text-[#3D3D3D] text-sm hover:border-[#1F3A2E]/40 transition-colors min-h-[44px]"
              >
                <Globe className="w-3.5 h-3.5" />
                <span>{LANG_LABELS[language]}</span>
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {langOpen && (
                <div className="absolute right-0 top-full mt-1 bg-white rounded-xl border border-[#1F3A2E]/10 shadow-lg py-1 z-50 min-w-[100px]">
                  {(["en", "es", "zh"] as Lang[]).map((l) => (
                    <button
                      key={l}
                      onClick={() => { onLanguageChange(l); setLangOpen(false); }}
                      className={`w-full text-left px-4 py-3 text-sm transition-colors hover:bg-[#F4F1EA] min-h-[44px] flex items-center ${language === l ? "text-[#1F3A2E] font-semibold" : "text-[#3D3D3D]"}`}
                    >
                      {LANG_LABELS[l]}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              aria-label="Settings"
              className="flex items-center gap-1.5 p-2.5 rounded-full border border-[#1F3A2E]/20 text-[#3D3D3D] hover:border-[#1F3A2E]/40 transition-colors min-h-[44px]"
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>
        </nav>

        {/* Main content — Prana centered */}
        <div className="flex-1 flex flex-col items-center justify-center px-4 sm:px-6 py-6 sm:py-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="text-center space-y-6 w-full max-w-sm md:max-w-lg"
          >
            <span className="font-serif text-[#1F3A2E] text-6xl sm:text-7xl md:text-8xl font-medium tracking-tight">
              Prana
            </span>
            <div className="flex justify-center">
              <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#7BA8A3]/15">
                <Check className="w-3.5 h-3.5 text-[#7BA8A3]" />
                <span className="text-xs sm:text-sm text-[#3D3D3D]">{t.tagline}</span>
              </div>
            </div>
          </motion.div>
        </div>

        {/* Bottom CTA */}
        <div
          className="px-4 sm:px-6 w-full"
          style={{ paddingBottom: "max(2.5rem, env(safe-area-inset-bottom, 2.5rem))" }}
        >
          <div className="max-w-sm md:max-w-md mx-auto space-y-3">
            <motion.button
              onClick={() => setStarted(true)}
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.99 }}
              className="w-full bg-[#1F3A2E] text-white rounded-full font-medium text-lg hover:bg-[#2A4D3D] transition-colors min-h-[56px]"
            >
              {t.startTalking}
            </motion.button>
            <div className="flex items-center justify-center gap-4">
              <button
                onClick={() => { setTextMode(true); setStarted(true); }}
                className="text-[#3D3D3D] text-sm underline underline-offset-2 hover:text-[#1F3A2E] transition-colors py-3 min-h-[44px]"
              >
                {t.typeSymptoms}
              </button>
              <span className="text-[#6B7280] text-xs">·</span>
              <a
                href="/dashboard?run_id=demo"
                className="text-[#6B7280] text-sm hover:text-[#1F3A2E] transition-colors py-3 min-h-[44px] inline-flex items-center"
              >
                {t.previewDemo}
              </a>
            </div>
            <p className="text-center text-xs text-[#6B7280] px-2 pt-1 leading-relaxed">{t.disclaimer}</p>
          </div>
        </div>

      </div>
    </SessionProvider>
  );
}

function HomePageInner() {
  const params = useSearchParams();
  const [showHistory, setShowHistory] = useState(params.get("history") === "true");
  const [language, setLanguage] = useState<Lang>("en");

  // Hydrate from shared storage on mount, and persist any changes
  useEffect(() => {
    import("@/lib/language").then(({ getLang, subscribeLang }) => {
      setLanguage(getLang());
      const unsub = subscribeLang((l) => setLanguage(l));
      return unsub;
    });
  }, []);

  const handleLanguageChange = (l: Lang) => {
    setLanguage(l);
    import("@/lib/language").then(({ setLang }) => setLang(l));
  };

  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {showHistory ? (
        <RecentSessions onClose={() => setShowHistory(false)} />
      ) : (
        <VoiceIntake
          key={language}
          language={language}
          onLanguageChange={handleLanguageChange}
          onShowHistory={() => setShowHistory(true)}
        />
      )}
    </main>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={null}>
      <HomePageInner />
    </Suspense>
  );
}
