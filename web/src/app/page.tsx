"use client";

import { useEffect, useRef, useState, useCallback } from "react";
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
import { useRouter } from "next/navigation";

const URGENCY_COLORS: Record<string, string> = {
  emergency: "#f87171", urgent: "#fb923c", routine: "#22d3ee", wellness: "#34d399",
};
const PATH_ICONS: Record<string, string> = {
  doctor: "🏥", pharmacy: "💊", mental_health: "🌊", alt_medicine: "🌿", self_care: "✨",
};

function RecentSessions() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const router = useRouter();

  useEffect(() => {
    listRuns()
      .then((data) => { if (Array.isArray(data)) setRuns(data.slice(0, 6)); })
      .catch(() => {});
  }, []);

  if (!runs.length) return null;

  return (
    <div style={{ width: "100%", maxWidth: 480 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "#475569", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>
        Recent Sessions
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {runs.map((run) => {
          const label = run.rd_summary ?? run.intake_summary ?? run.instruction ?? "Intake session";
          const icon = PATH_ICONS[run.recommended_path ?? ""] ?? "🩺";
          const color = URGENCY_COLORS[run.urgency ?? ""] ?? "#64748b";
          const date = new Date(run.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
          return (
            <button
              key={run.id}
              onClick={() => router.push(`/dashboard?run_id=${run.id}`)}
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 12,
                padding: "12px 14px",
                cursor: "pointer",
                textAlign: "left",
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                transition: "border-color 0.15s",
              }}
            >
              <span style={{ fontSize: 18, flexShrink: 0 }}>{icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {label.length > 72 ? label.slice(0, 72) + "…" : label}
                </div>
                <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
                  {date} · {(run.recommended_path ?? "pending").replace(/_/g, " ")}
                </div>
              </div>
              {run.urgency && (
                <span style={{
                  fontSize: 10, fontWeight: 700, color, background: color + "20",
                  borderRadius: 9999, padding: "2px 7px", whiteSpace: "nowrap", flexShrink: 0,
                }}>
                  {run.urgency}
                </span>
              )}
              <span style={{ color: "#475569", fontSize: 12, flexShrink: 0 }}>→</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const tokenSource = TokenSource.endpoint("/api/token");

interface IntakeData {
  summary?: string;
  symptoms?: string[];
  suggested_path?: string;
  urgency?: string;
}

function RoomView({ onIntakeComplete }: { onIntakeComplete: (data: IntakeData) => void }) {
  const agent = useAgent();
  const [transcript, setTranscript] = useState<string[]>([]);
  const intakeRef = useRef<IntakeData>({});

  const onData = useCallback((msg: { payload: Uint8Array }) => {
    try {
      const text = new TextDecoder().decode(msg.payload);
      const data = JSON.parse(text);
      if (data.type === "symptoms_extracted") {
        intakeRef.current.symptoms = data.symptoms;
      } else if (data.type === "urgency_set") {
        intakeRef.current.urgency = data.urgency;
      } else if (data.type === "intake_complete") {
        intakeRef.current = { ...intakeRef.current, ...data };
        onIntakeComplete(intakeRef.current);
      }
    } catch { /* ignore malformed */ }
  }, [onIntakeComplete]);

  useDataChannel(onData);

  const stateColor = agent.state === "speaking" ? "#22d3ee"
    : agent.state === "listening" ? "#34d399"
    : agent.state === "thinking" ? "#f59e0b"
    : "#475569";

  return (
    <div className="flex flex-col items-center gap-8 w-full max-w-lg">
      {/* Agent visualizer */}
      <div className="relative w-64 h-64 rounded-full flex items-center justify-center"
        style={{ background: "radial-gradient(circle, rgba(34,211,238,0.06) 0%, transparent 70%)", border: "1px solid rgba(34,211,238,0.12)" }}>
        <BarVisualizer
          state={agent.state}
          barCount={9}
          track={agent.microphoneTrack}
          style={{ width: "60%", height: "40%" }}
        />
        <div className="absolute bottom-6 flex items-center gap-2 text-xs" style={{ color: "#64748b" }}>
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: stateColor, boxShadow: `0 0 6px ${stateColor}` }} />
          CareFlow · {agent.state ?? "connecting"}
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3" data-lk-theme="default">
        <TrackToggle
          source={Track.Source.Microphone}
          style={{ padding: "10px 20px", borderRadius: "9999px", background: "rgba(255,255,255,0.06)", color: "#cbd5e1", fontSize: 13, cursor: "pointer", border: "none" }}
        />
        <DisconnectButton style={{ padding: "10px 20px", borderRadius: "9999px", background: "rgba(239,68,68,0.15)", color: "#f87171", fontSize: 13, cursor: "pointer", border: "none" }}>
          End Session
        </DisconnectButton>
      </div>

      <RoomAudioRenderer />
    </div>
  );
}

function VoiceIntake() {
  const session = useSession(tokenSource);
  const [started, setStarted] = useState(false);
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

      // Fire composio tasks in background
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
          <h2>Your CareFlow Wellness Intake</h2>
          <p><strong>Summary:</strong> ${data.summary}</p>
          <p><strong>Concerns noted:</strong> ${data.symptoms?.join(", ") ?? "See dashboard"}</p>
          <p><strong>Suggested path:</strong> ${data.suggested_path ?? "review dashboard"}</p>
          <p><strong>Urgency:</strong> ${data.urgency ?? "wellness"}</p>
          <hr/>
          <p><em>CareFlow is a wellness education and care-navigation tool. This is not a medical diagnosis. Please consult a licensed healthcare professional for medical advice.</em></p>
        `;
        fetch("/api/composio/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subject: "Your CareFlow Wellness Intake Summary", body: emailBody }),
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
    if (started) session.start().catch(console.error);
    else session.end().catch(() => {});
  }, [started, session]);

  useEvents(session, SessionEvent.MediaDevicesError, (error) => {
    const failure = MediaDeviceFailure.getFailure(error);
    console.error("Media device failure:", failure);
    alert("Microphone access required. Please grant mic permissions and reload.");
  }, []);

  return (
    <SessionProvider session={session}>
      <div className="flex flex-col items-center gap-8 w-full px-6">
        {/* Disclaimer banner */}
        <div style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 12, padding: "12px 20px", fontSize: 13, color: "#92400e", maxWidth: 480, textAlign: "center" }}>
          ⚠️ CareFlow is a <strong>wellness education tool</strong> — not a substitute for licensed medical care. For emergencies, call <strong>911</strong>.
        </div>

        {started ? (
          submitting ? (
            <div style={{ color: "#22d3ee", fontSize: 18 }}>Saving your intake summary…</div>
          ) : (
            <RoomView onIntakeComplete={handleIntakeComplete} />
          )
        ) : (
          <div className="flex flex-col items-center gap-6" style={{ textAlign: "center" }}>
            <div style={{ fontSize: 64 }}>🩺</div>
            <h2 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Tell me about your health</h2>
            <p style={{ color: "#64748b", maxWidth: 360, margin: 0, lineHeight: 1.6 }}>
              Start a voice session and speak naturally about your symptoms, stress, or wellness goals. CareFlow will listen and guide you to the right resources.
            </p>
            <button className="btn-primary" onClick={() => setStarted(true)} style={{ fontSize: 16, padding: "14px 36px" }}>
              Begin Voice Intake
            </button>
          </div>
        )}
      </div>
    </SessionProvider>
  );
}

export default function HomePage() {
  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", padding: "40px 20px", gap: 32 }}>
      <div style={{ textAlign: "center", marginBottom: 8 }}>
        <h1 style={{ fontSize: 36, fontWeight: 800, margin: 0, letterSpacing: "-0.02em" }}>
          <span style={{ color: "#22d3ee" }}>Care</span>Flow
        </h1>
        <p style={{ color: "#64748b", marginTop: 8, fontSize: 15 }}>Voice-first wellness navigation · Powered by AI agents</p>
      </div>
      <VoiceIntake />
      <RecentSessions />
    </main>
  );
}
