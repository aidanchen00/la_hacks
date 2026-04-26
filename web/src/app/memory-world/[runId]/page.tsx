"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { useOdyssey } from "@odysseyml/odyssey/react";
import { credentialsFromDict, Odyssey } from "@odysseyml/odyssey";
import { motion } from "motion/react";
import {
  LiveKitRoom,
  useVoiceAssistant,
  BarVisualizer,
  RoomAudioRenderer,
  TrackToggle,
  DisconnectButton,
} from "@livekit/components-react";
import { Track } from "livekit-client";
import "@livekit/components-styles";
import LanguagePicker from "@/app/components/LanguagePicker";
import {
  SEED_MEMORIES,
  DEFAULT_MEMORY_PROMPT,
  loadUserMemories,
  addMemory,
  removeMemory,
  fileToDataUrl,
  resolveMemorySrc,
  type Memory,
} from "@/lib/memories";
import { getLang } from "@/lib/language";
import { getRun } from "@/lib/api";

// ---------------------------------------------------------------------------
// LocalStorage tracking of recent Odyssey credentials so a fresh page-load
// can reach back to prior streams and tear them down (Odyssey caps concurrent
// streams per account; tab reloads otherwise leak slots).
// ---------------------------------------------------------------------------

const ODY_KEY = "prana.odyssey.active_creds.v1";

interface StoredCreds {
  raw: Record<string, unknown>;
  expiresAt: number;
}

function loadStoredOdysseyCreds(): StoredCreds[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(ODY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as StoredCreds[];
    return Array.isArray(arr) ? arr.filter((c) => c.expiresAt > Date.now()) : [];
  } catch { return []; }
}

function saveOdysseyCreds(c: StoredCreds): void {
  if (typeof window === "undefined") return;
  try {
    const next = [...loadStoredOdysseyCreds(), c];
    localStorage.setItem(ODY_KEY, JSON.stringify(next));
  } catch { /* quota or disabled */ }
}

function clearOdysseyCreds(): void {
  if (typeof window === "undefined") return;
  try { localStorage.removeItem(ODY_KEY); } catch { /* ignore */ }
}

/** Reconnect to every still-valid prior session and end it; returns count killed. */
async function reapPriorOdysseyStreams(): Promise<number> {
  const stored = loadStoredOdysseyCreds();
  if (!stored.length) return 0;
  let killed = 0;
  for (const s of stored) {
    try {
      const reaper = new Odyssey({});
      await reaper.connectWithCredentials(credentialsFromDict(s.raw));
      try { await reaper.endStream(); } catch { /* may not be running */ }
      reaper.disconnect();
      killed++;
    } catch { /* token expired or session already gone — nothing to do */ }
  }
  clearOdysseyCreds();
  return killed;
}

// ---------------------------------------------------------------------------
// Dr. Aria — psychiatrist voice agent (LiveKit room)
// Same pattern as the alt-medicine call window but uses room name prefix
// `mental-` so the agent worker spins up the psychiatrist persona with the
// calmer Eleven Labs voice.
// ---------------------------------------------------------------------------

function TherapistCallContent() {
  const { state, audioTrack } = useVoiceAssistant();
  const stateColor =
    state === "speaking" ? "#1F3A2E"
    : state === "listening" ? "#16A34A"
    : state === "thinking" ? "#D97706"
    : "#6B7280";
  return (
    <div className="px-4 pt-4 pb-5 flex flex-col gap-3.5 items-center">
      <BarVisualizer
        state={state}
        barCount={7}
        trackRef={audioTrack}
        className="w-full"
        style={{ height: 52 }}
      />
      <div className="flex items-center gap-2 text-xs text-[#6B7280]">
        <span
          className="w-2 h-2 rounded-full inline-block"
          style={{ background: stateColor, boxShadow: `0 0 6px ${stateColor}` }}
        />
        {state ?? "connecting…"}
      </div>
      <div className="flex gap-2" data-lk-theme="default">
        <TrackToggle
          source={Track.Source.Microphone}
          className="px-4 py-2.5 rounded-full text-sm cursor-pointer border-none"
          style={{ background: "rgba(31,58,46,0.06)", color: "#1F3A2E", minHeight: 44 }}
        />
        <DisconnectButton
          className="px-4 py-2.5 rounded-full text-sm cursor-pointer border-none"
          style={{ background: "#FEE2E2", color: "#DC2626", minHeight: 44 }}
        >
          End Call
        </DisconnectButton>
      </div>
      <RoomAudioRenderer />
    </div>
  );
}

function TherapistCallWindow({
  runId,
  onClose,
}: {
  runId: string;
  onClose: () => void;
}) {
  const [conn, setConn] = useState<{ serverUrl: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const roomNameRef = useRef(`mental-${runId || "no-run"}-${Date.now()}`);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const lang = getLang();

      let intake_context = "";
      try {
        if (runId && runId !== "no-run") {
          const run = await getRun(runId).catch(() => null);
          if (run) {
            const rd = run.routing_decision;
            const parts: string[] = [];
            if (run.intake_summary) parts.push(`Intake summary: ${run.intake_summary}`);
            if (rd?.summary) parts.push(`Routing summary: ${rd.summary}`);
            if (rd?.urgency) parts.push(`Urgency: ${rd.urgency}`);
            if (rd?.recommended_path) parts.push(`Suggested path: ${rd.recommended_path}`);
            if (Array.isArray(rd?.next_actions) && rd.next_actions.length) parts.push(`Next actions: ${rd.next_actions.join("; ")}`);
            intake_context = parts.join("\n");
          }
        }
        if (!intake_context) {
          const r = await fetch(`/api/runs`);
          if (r.ok) {
            const runs = await r.json();
            const latest = Array.isArray(runs) && runs.length > 0 ? runs[0] : null;
            if (latest) {
              const parts = [];
              if (latest.intake_summary) parts.push(`Intake summary: ${latest.intake_summary}`);
              if (latest.rd_summary) parts.push(`Routing summary: ${latest.rd_summary}`);
              if (latest.urgency) parts.push(`Urgency: ${latest.urgency}`);
              if (latest.recommended_path) parts.push(`Suggested path: ${latest.recommended_path}`);
              intake_context = parts.join("\n");
            }
          }
        }
      } catch { /* ignore */ }

      try {
        const res = await fetch(`/api/token?lang=${lang}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            room_name: roomNameRef.current,
            participant_name: "user",
            metadata: { intake_context },
          }),
        });
        const data = await res.json();
        if (!cancelled) setConn({ serverUrl: data.serverUrl, token: data.participantToken });
      } catch {
        if (!cancelled) setError("Failed to connect to Dr. Aria");
      }
    })();
    return () => { cancelled = true; };
  }, [runId]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      style={{
        position: "fixed",
        bottom: 24,
        right: 24,
        width: 320,
        zIndex: 1000,
        borderRadius: 16,
        background: "#F4F1EA",
        border: "1px solid rgba(31,58,46,0.20)",
        boxShadow: "0 8px 32px rgba(31,58,46,0.18), 0 4px 12px rgba(31,58,46,0.12)",
        overflow: "hidden",
      }}
    >
      <div
        className="px-4 py-3.5 flex items-center gap-2.5"
        style={{ borderBottom: "1px solid rgba(31,58,46,0.10)", background: "linear-gradient(135deg, rgba(31,58,46,0.06), transparent)" }}
      >
        <span style={{ fontSize: 22 }}>🌿</span>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm text-[#1F3A2E] truncate">Dr. Aria</div>
          <div className="text-xs mt-0.5 text-[#1F3A2E]/60">Psychiatrist · here to listen</div>
        </div>
        <button
          onClick={onClose}
          className="bg-transparent border-none cursor-pointer leading-none px-2 py-1 flex items-center justify-center flex-shrink-0"
          style={{ color: "#6B7280", fontSize: 24, minHeight: 44, minWidth: 44 }}
          aria-label="Close call"
        >
          ×
        </button>
      </div>

      {error ? (
        <div className="px-5 py-5 text-center text-xs text-[#DC2626]">{error}</div>
      ) : !conn ? (
        <div className="px-7 py-7 text-center text-xs text-[#6B7280]">Connecting to Dr. Aria…</div>
      ) : (
        <LiveKitRoom
          serverUrl={conn.serverUrl}
          token={conn.token}
          connect={true}
          audio={true}
          video={false}
          onDisconnected={onClose}
        >
          <TherapistCallContent />
        </LiveKitRoom>
      )}
    </motion.div>
  );
}

export default function MemoryWorldPage() {
  const { runId } = useParams<{ runId: string }>();
  const [prompt, setPrompt] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [userMemories, setUserMemories] = useState<Memory[]>([]);
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);
  const [therapistOpen, setTherapistOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setUserMemories(loadUserMemories()); }, []);

  const [credentials, setCredentials] = useState<ReturnType<typeof credentialsFromDict> | null>(null);

  const odyssey = useOdyssey({
    apiKey: process.env.NEXT_PUBLIC_ODYSSEY_API_KEY,
    handlers: {
      onConnected: (stream) => {
        if (videoRef.current) videoRef.current.srcObject = stream;
      },
      onStreamStarted: () => setStreaming(true),
      onStreamEnded: () => setStreaming(false),
      onError: (err) => setError(err.message),
    },
  });

  const stopStream = useCallback(async () => {
    try { await odyssey.endStream(); } catch { /* ignore */ }
    try { odyssey.disconnect(); } catch { /* ignore */ }
    setStreaming(false);
    if (videoRef.current) videoRef.current.srcObject = null;
    setCredentials(null);
    clearOdysseyCreds();
  }, [odyssey]);

  const reapStaleStreams = async () => {
    setError(null);
    setLoading(true);
    try {
      const killed = await reapPriorOdysseyStreams();
      setError(killed > 0
        ? `Reaped ${killed} prior stream${killed === 1 ? "" : "s"}. Try Start Livestream again.`
        : "No reapable streams found. If you still see active streams in the Odyssey dashboard, they were started from a different browser/device — wait for them to time out or end them manually."
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reap failed");
    } finally {
      setLoading(false);
    }
  };

  // Single click handler: shut down any prior stream (this tab AND saved
  // sessions from previous reloads) to free the Odyssey slot, then mint
  // fresh credentials + connect + start.
  const startStream = async () => {
    setError(null);
    setLoading(true);
    try {
      // 1a. Cleanup: end + disconnect any active stream from this page
      try { await odyssey.endStream(); } catch { /* may not be running */ }
      try { odyssey.disconnect(); } catch { /* may not be connected */ }

      // 1b. Reap any sessions left over from prior reloads on this browser
      const reaped = await reapPriorOdysseyStreams();
      if (reaped > 0) console.info(`[odyssey] reaped ${reaped} stale stream(s)`);

      // 2. Fresh credentials
      const res = await fetch("/api/odyssey", { method: "POST" });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const credsRaw = data.credentials as Record<string, unknown>;
      const creds = credentialsFromDict(credsRaw);
      setCredentials(creds);
      // Track for future reaping. Default 15-min TTL if expiresIn missing.
      const expiresInSec = Number(credsRaw.expiresIn ?? credsRaw.expires_in ?? 900);
      saveOdysseyCreds({ raw: credsRaw, expiresAt: Date.now() + expiresInSec * 1000 });

      // 3. Connect + start
      await odyssey.connect();
      await odyssey.startStream({
        prompt: prompt.trim()
          ? `Calming, healing world: ${prompt}`
          : DEFAULT_MEMORY_PROMPT,
        portrait: false,
        ...(imageFile ? { image: imageFile } : {}),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Stream failed");
      setStreaming(false);
    } finally {
      setLoading(false);
    }
  };

  // Best-effort cleanup on unmount + tab close so we don't orbit the slot.
  useEffect(() => {
    const cleanup = () => {
      try { odyssey.disconnect(); } catch { /* ignore */ }
    };
    window.addEventListener("beforeunload", cleanup);
    return () => {
      window.removeEventListener("beforeunload", cleanup);
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== "image/jpeg" && file.type !== "image/png") {
      setError("Please upload a JPEG or PNG image.");
      return;
    }
    setError(null);
    setImageFile(file);
    const dataUrl = await fileToDataUrl(file);
    setImagePreview(dataUrl);
    // Save to the user's library so it can be re-used
    const next = addMemory({
      id: `mem-${Date.now()}`,
      title: file.name.replace(/\.[^.]+$/, "").slice(0, 40) || "My memory",
      src: dataUrl,
      createdAt: Date.now(),
    });
    setUserMemories(next);
    // Newly uploaded photos go into the library AND become the active seed,
    // so let the image drive the generation instead of competing with text.
    setPrompt(DEFAULT_MEMORY_PROMPT);
    setSelectedMemoryId(null);
  };

  const pickMemory = async (m: Memory) => {
    setError(null);
    setSelectedMemoryId(m.id);
    setImagePreview(m.src);
    // Use a general prompt so Odyssey is guided by the image, not the text
    setPrompt(m.customPrompt ?? DEFAULT_MEMORY_PROMPT);
    try {
      const file = await resolveMemorySrc(m.src);
      setImageFile(file);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load memory");
    }
  };

  const deleteMemory = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setUserMemories(removeMemory(id));
    if (selectedMemoryId === id) {
      setSelectedMemoryId(null);
      setImageFile(null);
      setImagePreview(null);
    }
  };

  // Single-button entry point — startStream already does cleanup-then-start
  const relaunch = startStream;

  const statusLabel = () => {
    if (streaming) return "● Live";
    if (loading || odyssey.status === "connecting" || odyssey.status === "authenticating") return "Connecting…";
    if (odyssey.status === "failed") return "Failed";
    return "Idle";
  };

  const statusColor = () => {
    if (streaming) return "#16A34A";
    if (odyssey.status === "failed") return "#DC2626";
    return "#6B7280";
  };

  return (
    <div className="min-h-screen bg-[#F4F1EA]">
      <div className="px-4 sm:px-6 py-6 sm:py-8 max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-3 mb-6">
          <a
            href={`/dashboard?run_id=${runId}`}
            className="text-[#1F3A2E] text-sm font-medium hover:opacity-70 transition-opacity min-h-[44px] flex items-center"
          >
            ← Dashboard
          </a>
          <h1 className="font-serif text-[#1F3A2E] text-xl sm:text-2xl font-medium">Memory World</h1>
          <div className="ml-auto flex items-center gap-3">
            <span
              className="text-xs font-semibold uppercase tracking-wider"
              style={{ color: statusColor() }}
            >
              {statusLabel()}
            </span>
            <button
              onClick={() => setTherapistOpen(true)}
              disabled={therapistOpen}
              className="flex items-center gap-1.5 px-3 py-2 rounded-full text-xs sm:text-sm font-medium transition-colors min-h-[36px] disabled:opacity-50 disabled:cursor-default"
              style={{
                background: "rgba(31,58,46,0.08)",
                color: "#1F3A2E",
                border: "1px solid rgba(31,58,46,0.20)",
              }}
              title="Talk to Dr. Aria — psychiatrist voice agent"
            >
              <span style={{ fontSize: 14 }}>🌿</span>
              <span>Talk to Dr. Aria</span>
            </button>
            <LanguagePicker />
          </div>
        </div>

        <p className="text-[#6B7280] text-sm mb-6 max-w-xl leading-relaxed">
          Describe a calming memory or place and Prana will generate a live immersive video stream
          to help you relax and restore.
        </p>

        {/* Live video */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative rounded-2xl overflow-hidden border border-[#1F3A2E]/15 bg-[#1F3A2E] mb-6"
          style={{ aspectRatio: "16/9" }}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={false}
            className="w-full h-full object-cover block"
          />
          {!streaming && (
            <div className="absolute inset-0 flex items-center justify-center text-[#EFEAE0]/60 text-sm">
              {loading || odyssey.status === "connecting" || odyssey.status === "authenticating"
                ? "Connecting to live stream…"
                : "Stream not started"}
            </div>
          )}
        </motion.div>

        {error && (
          <div className="bg-[#FEE2E2] border border-[#DC2626]/20 rounded-2xl px-4 py-3 mb-4 text-sm text-[#DC2626] flex items-start justify-between gap-3">
            <span className="flex-1">{error}</span>
            <button
              type="button"
              onClick={reapStaleStreams}
              disabled={loading}
              className="text-[#1F3A2E] underline whitespace-nowrap hover:opacity-70 disabled:opacity-50"
            >
              Reset stale streams
            </button>
          </div>
        )}

        <div className="bg-[#EFEAE0] rounded-2xl p-6 max-w-xl">
          <div className="mb-4">
            <label className="block text-sm text-[#6B7280] mb-2">Describe your calming memory or place</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              disabled={streaming}
              className="w-full bg-[#F4F1EA] border border-[#1F3A2E]/20 rounded-xl px-4 py-3 text-[#3D3D3D] focus:outline-none focus:border-[#1F3A2E]/50 resize-y disabled:opacity-50"
              style={{ fontSize: 16 }}
            />
          </div>

          <div className="mb-5">
            <label className="block text-sm text-[#6B7280] mb-2">
              Pick from your library, or upload a new memory
            </label>

            {/* Library grid */}
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mb-3">
              {[...userMemories, ...SEED_MEMORIES].map((m) => {
                const isSel = selectedMemoryId === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => !streaming && pickMemory(m)}
                    disabled={streaming}
                    className={`relative group aspect-square rounded-xl overflow-hidden border-2 transition-all ${
                      isSel
                        ? "border-[#1F3A2E]"
                        : "border-[#1F3A2E]/15 hover:border-[#1F3A2E]/40"
                    } ${streaming ? "opacity-50 cursor-default" : "cursor-pointer"}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={m.src} alt={m.title} className="w-full h-full object-cover" />
                    <div className="absolute inset-0 flex items-end p-1.5 bg-gradient-to-t from-black/60 via-black/0 to-transparent">
                      <span className="text-[10px] text-white font-medium leading-tight line-clamp-2">
                        {m.title}
                      </span>
                    </div>
                    {!m.seed && !streaming && (
                      <span
                        onClick={(e) => deleteMemory(m.id, e)}
                        className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        aria-label="Remove from library"
                      >
                        ×
                      </span>
                    )}
                  </button>
                );
              })}

              {/* Upload tile */}
              <button
                type="button"
                onClick={() => !streaming && fileRef.current?.click()}
                disabled={streaming}
                className={`aspect-square rounded-xl border-2 border-dashed border-[#1F3A2E]/25 flex flex-col items-center justify-center text-center px-2 transition-colors ${
                  streaming ? "opacity-50 cursor-default" : "cursor-pointer hover:border-[#1F3A2E]/50 hover:bg-[#1F3A2E]/5"
                }`}
              >
                <span className="text-2xl text-[#1F3A2E]/60 leading-none mb-1">+</span>
                <span className="text-[10px] text-[#6B7280] leading-tight">Upload new</span>
              </button>
            </div>

            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png"
              className="hidden"
              onChange={handleFileChange}
            />

            {imagePreview && (
              <div className="text-xs text-[#6B7280] mt-1">
                Selected as visual seed.{" "}
                <button
                  type="button"
                  onClick={() => { setImageFile(null); setImagePreview(null); setSelectedMemoryId(null); }}
                  disabled={streaming}
                  className="text-[#1F3A2E] underline disabled:opacity-50"
                >
                  Clear
                </button>
              </div>
            )}
          </div>

          <div className="flex gap-3">
            {streaming ? (
              <motion.button
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.99 }}
                onClick={stopStream}
                className="flex-1 bg-[#DC2626] text-white rounded-full font-medium text-sm hover:bg-[#B91C1C] transition-colors min-h-[48px]"
              >
                Stop Stream
              </motion.button>
            ) : (
              <motion.button
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.99 }}
                onClick={relaunch}
                disabled={loading}
                className="flex-1 bg-[#1F3A2E] text-white rounded-full font-medium text-sm hover:bg-[#2A4D3D] transition-colors disabled:opacity-40 min-h-[48px]"
              >
                {loading ? "Starting…" : "Start Livestream"}
              </motion.button>
            )}
          </div>
        </div>
      </div>

      {therapistOpen && (
        <TherapistCallWindow runId={runId} onClose={() => setTherapistOpen(false)} />
      )}
    </div>
  );
}
