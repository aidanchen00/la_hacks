"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
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
import "mapbox-gl/dist/mapbox-gl.css";
import { getLang } from "@/lib/language";
import LanguagePicker from "@/app/components/LanguagePicker";
import { getRun } from "@/lib/api";

const TRADITIONS = {
  TCM: {
    label: "Traditional Chinese Medicine",
    emoji: "🐉",
    coords: [116.4074, 39.9042],
    zoom: 4,
    color: "#B45309",
    description: "Rooted in 3,000+ years of practice, TCM encompasses acupuncture, herbal medicine, tai chi, and qigong. It views health as a balance of Qi (vital energy) flowing through meridians. Common practices address pain, digestion, fertility, and immune health.",
    practices: ["Acupuncture", "Herbal formulas", "Tai Chi", "Qigong", "Cupping", "Moxibustion"],
    persona: "You are a Traditional Chinese Medicine educator. Speak with warmth and wisdom about TCM philosophy, Qi, yin/yang balance, and common herbal remedies. Always remind the user you are an educational guide, not a licensed TCM practitioner.",
  },
  Ayurveda: {
    label: "Ayurveda",
    emoji: "🌿",
    coords: [78.9629, 20.5937],
    zoom: 4,
    color: "#A16207",
    description: "India's ancient system of medicine (5,000+ years old), Ayurveda focuses on prakriti (individual constitution), the three doshas (Vata, Pitta, Kapha), and restoring balance through diet, herbs, yoga, and detox practices (Panchakarma).",
    practices: ["Dosha balancing", "Herbal oils & tonics", "Yoga & pranayama", "Panchakarma", "Dietary guidance"],
    persona: "You are an Ayurvedic wellness educator. Discuss doshas, prakriti, key herbs like ashwagandha and turmeric, and Ayurvedic lifestyle principles. Always remind the user this is educational, not medical advice.",
  },
  Kampo: {
    label: "Kampo",
    emoji: "⛩️",
    coords: [139.6917, 35.6895],
    zoom: 5,
    color: "#155E75",
    description: "Japan's traditional herbal medicine system, adapted from Chinese medicine over 1,500 years. Kampo uses standardized herbal formulas (e.g., Tsumura) and is integrated into Japan's modern healthcare system. Popular for gastrointestinal issues, fatigue, and women's health.",
    practices: ["Standardized herbal formulas", "Pulse diagnosis", "Abdominal palpation", "Combined with Western medicine"],
    persona: "You are a Kampo herbal medicine educator. Explain how Kampo differs from TCM, its integration into Japanese healthcare, and common formulas like Kuzu-to and Bofutsushosan. This is educational guidance only.",
  },
  Naturopathy: {
    label: "Naturopathy",
    emoji: "🌱",
    coords: [-105.2705, 40.0150],
    zoom: 4,
    color: "#1F3A2E",
    description: "A system emphasizing the body's innate healing ability through natural therapies: nutrition, herbal medicine, homeopathy, physical medicine, and lifestyle counseling. Popular in the US, Canada, and Australia.",
    practices: ["Clinical nutrition", "Botanical medicine", "Physical therapy", "Homeopathy", "Lifestyle medicine"],
    persona: "You are a naturopathic wellness educator. Discuss the six principles of naturopathy, common natural remedies, and evidence-based lifestyle approaches. Always advise consulting a licensed naturopathic doctor (ND) for personalized care.",
  },
  Indigenous: {
    label: "Indigenous & Holistic Wellness",
    emoji: "🌍",
    coords: [-100.0, 20.0],
    zoom: 2.5,
    color: "#7C2D12",
    description: "Indigenous healing traditions from around the world emphasize connection to land, community, ceremony, and plant medicine. These include Native American healing circles, African ubuntu wellness, and Aboriginal Australian practices.",
    practices: ["Plant medicine & foraging", "Ceremony & ritual", "Community healing circles", "Sweat lodges", "Storytelling as therapy"],
    persona: "You are a respectful guide to indigenous and holistic wellness traditions. Emphasize cultural respect, the importance of community, connection to nature, and the wisdom of traditional healers. Always encourage learners to seek indigenous healers directly. This is educational only.",
  },
} as const;

type TraditionKey = keyof typeof TRADITIONS;
type TraditionData = typeof TRADITIONS[TraditionKey];

// Theme tokens (match doctor / pharmacy pages)
const C = {
  bg: "#F4F1EA",
  surface: "#EFEAE0",
  border: "#1F3A2E",   // used at 10–20% opacity
  brand: "#1F3A2E",
  brandHover: "#2A4D3D",
  text: "#3D3D3D",
  muted: "#6B7280",
  success: "#16A34A",
  successBg: "#DCFCE7",
  error: "#DC2626",
};

// ---------------------------------------------------------------------------
// LiveKit call content — runs INSIDE <LiveKitRoom>
// ---------------------------------------------------------------------------

function CallContent({ tradition }: { tradition: TraditionData }) {
  // useVoiceAssistant works inside <LiveKitRoom>; useAgent requires a Session context
  const { state, audioTrack } = useVoiceAssistant();

  const stateColor =
    state === "speaking" ? tradition.color
    : state === "listening" ? C.success
    : state === "thinking" ? "#D97706"
    : C.muted;

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
          style={{ background: "rgba(31,58,46,0.06)", color: C.brand, minHeight: 44 }}
        />
        <DisconnectButton
          className="px-4 py-2.5 rounded-full text-sm cursor-pointer border-none"
          style={{ background: "#FEE2E2", color: C.error, minHeight: 44 }}
        >
          End Call
        </DisconnectButton>
      </div>
      <RoomAudioRenderer />
    </div>
  );
}

function AltMedicineCallWindow({
  traditionKey,
  tradition,
  onClose,
  isMobile,
  runId,
}: {
  traditionKey: TraditionKey;
  tradition: TraditionData;
  onClose: () => void;
  isMobile: boolean;
  runId: string;
}) {
  const [conn, setConn] = useState<{ serverUrl: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const roomNameRef = useRef(`altmed-${traditionKey}-${Date.now()}`);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const lang = getLang();

      // Fetch the most recent intake (or this specific run) to give the practitioner context
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
          // Fallback: latest run summary
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
      } catch { /* ignore — context is optional */ }

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
        if (!cancelled) setError("Failed to connect to agent");
      }
    })();
    return () => { cancelled = true; };
  }, [runId]);

  const baseStyle: React.CSSProperties = {
    background: C.surface,
    border: `1px solid ${tradition.color}40`,
    boxShadow: `0 8px 32px ${tradition.color}18, 0 4px 12px rgba(31,58,46,0.12)`,
  };

  const positionStyle: React.CSSProperties = isMobile
    ? { position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 1000, borderRadius: "16px 16px 0 0" }
    : { position: "fixed", bottom: 24, right: 24, width: 320, zIndex: 1000, borderRadius: 16 };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      style={{ ...positionStyle, ...baseStyle, overflow: "hidden" }}
    >
      {/* Header */}
      <div
        className="px-4 py-3.5 flex items-center gap-2.5"
        style={{
          borderBottom: `1px solid ${tradition.color}20`,
          background: `linear-gradient(135deg, ${tradition.color}10, transparent)`,
        }}
      >
        <span style={{ fontSize: 22 }}>{tradition.emoji}</span>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm text-[#1F3A2E] truncate">{tradition.label}</div>
          <div className="text-xs mt-0.5" style={{ color: tradition.color }}>
            Wellness Educator
          </div>
        </div>
        <button
          onClick={onClose}
          className="bg-transparent border-none cursor-pointer leading-none px-2 py-1 flex items-center justify-center flex-shrink-0"
          style={{ color: C.muted, fontSize: 24, minHeight: 44, minWidth: 44 }}
          aria-label="Close call"
        >
          ×
        </button>
      </div>

      {/* Body */}
      {error ? (
        <div className="px-5 py-5 text-center text-xs" style={{ color: C.error }}>{error}</div>
      ) : !conn ? (
        <div className="px-7 py-7 text-center text-xs" style={{ color: C.muted }}>
          Connecting to agent…
        </div>
      ) : (
        <LiveKitRoom
          serverUrl={conn.serverUrl}
          token={conn.token}
          connect={true}
          audio={true}
          video={false}
          onDisconnected={onClose}
        >
          <CallContent tradition={tradition} />
        </LiveKitRoom>
      )}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Mobile bottom sheet for selected tradition
// ---------------------------------------------------------------------------

function TraditionBottomSheet({
  tradition,
  onClose,
  onTalkToAgent,
}: {
  tradition: TraditionData;
  onClose: () => void;
  onTalkToAgent: () => void;
}) {
  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 z-40"
        style={{ background: "rgba(31,58,46,0.30)" }}
      />
      <motion.div
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", damping: 30, stiffness: 280 }}
        className="fixed bottom-0 left-0 right-0 z-50 overflow-y-auto"
        style={{
          background: C.surface,
          borderRadius: "16px 16px 0 0",
          maxHeight: "70vh",
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
          borderTop: `1px solid ${tradition.color}30`,
        }}
      >
        <div className="flex justify-center pt-3">
          <div className="w-10 h-1 rounded-full" style={{ background: "rgba(31,58,46,0.2)" }} />
        </div>

        <div className="px-5 pt-4 pb-6">
          <div className="flex items-center gap-3 mb-4">
            <span style={{ fontSize: 32 }}>{tradition.emoji}</span>
            <div>
              <h2 className="font-serif text-[#1F3A2E] text-lg font-medium m-0">
                {tradition.label}
              </h2>
              <div
                className="rounded-full mt-1.5"
                style={{ height: 3, width: 40, background: tradition.color }}
              />
            </div>
          </div>

          <p className="text-sm leading-relaxed mb-4" style={{ color: C.text }}>
            {tradition.description}
          </p>

          <div className="mb-5">
            <div
              className="text-xs uppercase tracking-wider mb-2"
              style={{ color: C.muted, letterSpacing: "0.08em" }}
            >
              Common Practices
            </div>
            <div className="flex flex-wrap gap-2">
              {tradition.practices.map((p) => (
                <span
                  key={p}
                  className="px-3 py-1.5 rounded-full text-xs"
                  style={{ background: `${tradition.color}18`, color: tradition.color }}
                >
                  {p}
                </span>
              ))}
            </div>
          </div>

          <motion.button
            whileTap={{ scale: 0.98 }}
            onClick={onTalkToAgent}
            className="w-full rounded-2xl font-medium cursor-pointer mb-3 flex items-center justify-center gap-2"
            style={{
              padding: 16,
              minHeight: 56,
              background: tradition.color,
              color: "#FFFFFF",
              fontSize: 15,
              border: "none",
            }}
          >
            <span style={{ fontSize: 16 }}>🎙️</span>
            Talk to {tradition.label} Agent
          </motion.button>

          <div
            className="px-4 py-2.5 rounded-xl text-xs leading-relaxed"
            style={{ background: C.bg, color: C.muted }}
          >
            ⚕️ Wellness education only. Consult a licensed practitioner before starting any
            traditional medicine regimen.
          </div>
        </div>
      </motion.div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function AltMedicinePage() {
  const { runId } = useParams<{ runId: string }>();
  const mapRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapInstanceRef = useRef<any>(null);
  const [selected, setSelected] = useState<TraditionKey | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let map: any;
    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!token) {
      console.error("[mapbox] NEXT_PUBLIC_MAPBOX_TOKEN is not set");
      return;
    }

    import("mapbox-gl").then((mb) => {
      const mgl = mb.default;
      mgl.accessToken = token;

      if (!mapRef.current) return;
      map = new mgl.Map({
        container: mapRef.current,
        style: "mapbox://styles/mapbox/light-v11",
        center: [20, 20],
        zoom: 1.8,
        projection: { name: "globe" },
      });

      map.on("error", (e: { error?: { message?: string } }) => {
        console.error("[mapbox] error:", e?.error?.message ?? e);
      });

      map.on("load", () => {
        map.setFog({
          color: "rgba(244,241,234,0.9)",
          "high-color": "rgba(244,241,234,0.7)",
          "horizon-blend": 0.05,
        });

        (Object.entries(TRADITIONS) as [TraditionKey, TraditionData][]).forEach(([key, t]) => {
          const el = document.createElement("div");
          el.style.cssText = `width:48px;height:48px;background:${t.color};border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:22px;cursor:pointer;border:2px solid #FFFFFF;box-shadow:0 0 0 3px ${t.color}25, 0 4px 12px rgba(31,58,46,0.20);transition:transform 0.15s;`;
          el.textContent = t.emoji;
          el.title = t.label;
          el.onmouseenter = () => { el.style.transform = "scale(1.15)"; };
          el.onmouseleave = () => { el.style.transform = "scale(1)"; };
          el.onclick = () => { selectTradition(key, map); };

          new mgl.Marker({ element: el })
            .setLngLat(t.coords as [number, number])
            .addTo(map);
        });

        setMapLoaded(true);
        mapInstanceRef.current = map;
      });
    });

    return () => map?.remove();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const selectTradition = (key: TraditionKey, map: any) => {
    const t = TRADITIONS[key];
    map.flyTo({ center: t.coords as [number, number], zoom: t.zoom, duration: 2000, essential: true });
    setSelected(key);
    setCallOpen(false);
  };

  const handleCardClick = (key: TraditionKey) => {
    const map = mapInstanceRef.current;
    if (!map) { setSelected(key); return; }
    selectTradition(key, map);
  };

  const tradition = selected ? TRADITIONS[selected] : null;

  return (
    <div className="min-h-screen flex flex-col" style={{ background: C.bg }}>
      {/* Header */}
      <div
        className="px-4 sm:px-6 py-3 flex items-center gap-3 flex-wrap flex-shrink-0"
        style={{ borderBottom: "1px solid rgba(31,58,46,0.10)", background: C.bg }}
      >
        <a
          href={`/dashboard?run_id=${runId}`}
          className="text-sm font-medium hover:opacity-70 transition-opacity flex items-center whitespace-nowrap"
          style={{ color: C.brand, minHeight: 44 }}
        >
          ← Dashboard
        </a>
        <h1 className="font-serif text-[#1F3A2E] text-lg sm:text-xl font-medium m-0 whitespace-nowrap">
          Global Healing Map
        </h1>
        {!isMobile && (
          <span className="text-xs" style={{ color: C.muted }}>
            Tap a pin or tradition to explore — then talk to an AI agent
          </span>
        )}
        <div className="ml-auto">
          <LanguagePicker />
        </div>
      </div>

      {/* Body */}
      <div
        className="flex-1 flex"
        style={{
          flexDirection: isMobile ? "column" : "row",
          minHeight: 0,
        }}
      >
        {/* Map */}
        <div
          className="relative"
          style={{
            flex: 1,
            height: isMobile ? "55vw" : "auto",
            minHeight: isMobile ? 260 : 400,
            minWidth: 0,
          }}
        >
          <div ref={mapRef} className="absolute inset-0" style={{ width: "100%", height: "100%" }} />
          {!mapLoaded && (
            <div
              className="absolute inset-0 flex items-center justify-center text-sm"
              style={{ background: C.bg, color: C.muted }}
            >
              Loading global healing map…
            </div>
          )}
        </div>

        {/* Side panel — desktop only */}
        {!isMobile && (
          <div
            className="overflow-y-auto"
            style={{
              width: 360,
              background: C.surface,
              borderLeft: "1px solid rgba(31,58,46,0.10)",
            }}
          >
            {tradition && selected ? (
              <motion.div
                key={selected}
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                className="px-6 py-7"
              >
                <div style={{ fontSize: 36 }} className="mb-2">{tradition.emoji}</div>
                <h2 className="font-serif text-[#1F3A2E] text-lg font-medium m-0 mb-1">
                  {tradition.label}
                </h2>
                <div
                  className="rounded-full mb-4"
                  style={{ height: 3, width: 48, background: tradition.color }}
                />
                <p className="text-sm leading-relaxed mb-5" style={{ color: C.text }}>
                  {tradition.description}
                </p>

                <div className="mb-5">
                  <div
                    className="text-xs uppercase mb-2"
                    style={{ color: C.muted, letterSpacing: "0.08em" }}
                  >
                    Common Practices
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {tradition.practices.map((p) => (
                      <span
                        key={p}
                        className="px-2.5 py-1 rounded-full text-xs"
                        style={{ background: `${tradition.color}15`, color: tradition.color }}
                      >
                        {p}
                      </span>
                    ))}
                  </div>
                </div>

                <motion.button
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.99 }}
                  onClick={() => setCallOpen(true)}
                  className="w-full rounded-full font-medium cursor-pointer mb-3 flex items-center justify-center gap-2"
                  style={{
                    padding: "12px 16px",
                    minHeight: 48,
                    background: C.brand,
                    color: "#FFFFFF",
                    fontSize: 14,
                    border: "none",
                  }}
                >
                  <span style={{ fontSize: 16 }}>🎙️</span>
                  Talk to {tradition.label} Agent
                </motion.button>

                <div
                  className="px-3.5 py-2.5 rounded-xl text-xs leading-relaxed"
                  style={{ background: C.bg, color: C.muted }}
                >
                  ⚕️ Wellness education only. Consult a licensed practitioner before starting any
                  traditional medicine regimen.
                </div>
              </motion.div>
            ) : (
              <div className="px-6 py-7">
                <div className="text-sm mb-5" style={{ color: C.muted }}>
                  Choose a healing tradition to explore:
                </div>
                {(Object.entries(TRADITIONS) as [TraditionKey, TraditionData][]).map(([key, t]) => (
                  <motion.button
                    key={key}
                    whileHover={{ x: 4 }}
                    onClick={() => handleCardClick(key)}
                    className="w-full rounded-2xl px-4 py-3.5 mb-2.5 cursor-pointer text-left flex items-center gap-3"
                    style={{
                      background: "#FFFFFF",
                      border: "1px solid rgba(31,58,46,0.10)",
                      minHeight: 60,
                    }}
                  >
                    <span style={{ fontSize: 24 }}>{t.emoji}</span>
                    <div>
                      <div className="font-medium text-sm text-[#1F3A2E]">{t.label}</div>
                      <div className="text-xs mt-0.5" style={{ color: t.color }}>{key}</div>
                    </div>
                  </motion.button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Mobile tradition list (when nothing selected) */}
        {isMobile && !selected && (
          <div
            className="overflow-y-auto px-4 pt-4 pb-8"
            style={{ background: C.surface }}
          >
            <div className="text-sm mb-4" style={{ color: C.muted }}>
              Choose a healing tradition to explore:
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {(Object.entries(TRADITIONS) as [TraditionKey, TraditionData][]).map(([key, t]) => (
                <motion.button
                  key={key}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => handleCardClick(key)}
                  className="rounded-2xl px-3 py-3.5 cursor-pointer text-left flex flex-col gap-1.5"
                  style={{
                    background: "#FFFFFF",
                    border: `1px solid ${t.color}30`,
                    minHeight: 80,
                  }}
                >
                  <span style={{ fontSize: 24 }}>{t.emoji}</span>
                  <div className="font-medium text-xs text-[#1F3A2E] leading-tight">{t.label}</div>
                </motion.button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Mobile bottom sheet */}
      {isMobile && selected && tradition && !callOpen && (
        <TraditionBottomSheet
          tradition={tradition}
          onClose={() => setSelected(null)}
          onTalkToAgent={() => setCallOpen(true)}
        />
      )}

      {/* Call window */}
      {callOpen && selected && tradition && (
        <AltMedicineCallWindow
          traditionKey={selected}
          tradition={tradition}
          onClose={() => setCallOpen(false)}
          isMobile={isMobile}
          runId={runId}
        />
      )}
    </div>
  );
}
