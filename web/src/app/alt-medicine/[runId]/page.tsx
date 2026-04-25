"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import type mapboxgl from "mapbox-gl";
import {
  LiveKitRoom,
  useAgent,
  BarVisualizer,
  RoomAudioRenderer,
  TrackToggle,
  DisconnectButton,
} from "@livekit/components-react";
import { Track } from "livekit-client";
import "@livekit/components-styles";

const TRADITIONS = {
  TCM: {
    label: "Traditional Chinese Medicine",
    emoji: "🐉",
    coords: [116.4074, 39.9042],
    zoom: 4,
    color: "#ef4444",
    description: "Rooted in 3,000+ years of practice, TCM encompasses acupuncture, herbal medicine, tai chi, and qigong. It views health as a balance of Qi (vital energy) flowing through meridians. Common practices address pain, digestion, fertility, and immune health.",
    practices: ["Acupuncture", "Herbal formulas", "Tai Chi", "Qigong", "Cupping", "Moxibustion"],
    persona: "You are a Traditional Chinese Medicine educator. Speak with warmth and wisdom about TCM philosophy, Qi, yin/yang balance, and common herbal remedies. Always remind the user you are an educational guide, not a licensed TCM practitioner.",
  },
  Ayurveda: {
    label: "Ayurveda",
    emoji: "🌿",
    coords: [78.9629, 20.5937],
    zoom: 4,
    color: "#f59e0b",
    description: "India's ancient system of medicine (5,000+ years old), Ayurveda focuses on prakriti (individual constitution), the three doshas (Vata, Pitta, Kapha), and restoring balance through diet, herbs, yoga, and detox practices (Panchakarma).",
    practices: ["Dosha balancing", "Herbal oils & tonics", "Yoga & pranayama", "Panchakarma", "Dietary guidance"],
    persona: "You are an Ayurvedic wellness educator. Discuss doshas, prakriti, key herbs like ashwagandha and turmeric, and Ayurvedic lifestyle principles. Always remind the user this is educational, not medical advice.",
  },
  Kampo: {
    label: "Kampo",
    emoji: "⛩️",
    coords: [139.6917, 35.6895],
    zoom: 5,
    color: "#22d3ee",
    description: "Japan's traditional herbal medicine system, adapted from Chinese medicine over 1,500 years. Kampo uses standardized herbal formulas (e.g., Tsumura) and is integrated into Japan's modern healthcare system. Popular for gastrointestinal issues, fatigue, and women's health.",
    practices: ["Standardized herbal formulas", "Pulse diagnosis", "Abdominal palpation", "Combined with Western medicine"],
    persona: "You are a Kampo herbal medicine educator. Explain how Kampo differs from TCM, its integration into Japanese healthcare, and common formulas like Kuzu-to and Bofutsushosan. This is educational guidance only.",
  },
  Naturopathy: {
    label: "Naturopathy",
    emoji: "🌱",
    coords: [-105.2705, 40.0150],
    zoom: 4,
    color: "#34d399",
    description: "A system emphasizing the body's innate healing ability through natural therapies: nutrition, herbal medicine, homeopathy, physical medicine, and lifestyle counseling. Popular in the US, Canada, and Australia.",
    practices: ["Clinical nutrition", "Botanical medicine", "Physical therapy", "Homeopathy", "Lifestyle medicine"],
    persona: "You are a naturopathic wellness educator. Discuss the six principles of naturopathy, common natural remedies, and evidence-based lifestyle approaches. Always advise consulting a licensed naturopathic doctor (ND) for personalized care.",
  },
  Indigenous: {
    label: "Indigenous & Holistic Wellness",
    emoji: "🌍",
    coords: [-100.0, 20.0],
    zoom: 2.5,
    color: "#a78bfa",
    description: "Indigenous healing traditions from around the world emphasize connection to land, community, ceremony, and plant medicine. These include Native American healing circles, African ubuntu wellness, and Aboriginal Australian practices.",
    practices: ["Plant medicine & foraging", "Ceremony & ritual", "Community healing circles", "Sweat lodges", "Storytelling as therapy"],
    persona: "You are a respectful guide to indigenous and holistic wellness traditions. Emphasize cultural respect, the importance of community, connection to nature, and the wisdom of traditional healers. Always encourage learners to seek indigenous healers directly. This is educational only.",
  },
} as const;

type TraditionKey = keyof typeof TRADITIONS;
type TraditionData = typeof TRADITIONS[TraditionKey];

// ---------------------------------------------------------------------------
// Mini LiveKit call window
// ---------------------------------------------------------------------------

function CallContent({ tradition, onClose }: { tradition: TraditionData; onClose: () => void }) {
  const agent = useAgent();
  const stateColor =
    agent.state === "speaking" ? "#22d3ee"
    : agent.state === "listening" ? "#34d399"
    : agent.state === "thinking" ? "#f59e0b"
    : "#475569";

  return (
    <div style={{ padding: "16px 16px 20px", display: "flex", flexDirection: "column", gap: 14, alignItems: "center" }}>
      <BarVisualizer
        state={agent.state}
        barCount={7}
        track={agent.microphoneTrack}
        style={{ width: "100%", height: 52 }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#64748b" }}>
        <span style={{
          width: 8, height: 8, borderRadius: "50%", display: "inline-block",
          background: stateColor, boxShadow: `0 0 6px ${stateColor}`,
        }} />
        {agent.state ?? "connecting…"}
      </div>
      <div style={{ display: "flex", gap: 8 }} data-lk-theme="default">
        <TrackToggle
          source={Track.Source.Microphone}
          style={{ padding: "8px 16px", borderRadius: 9999, background: "rgba(255,255,255,0.06)", color: "#cbd5e1", fontSize: 12, cursor: "pointer", border: "none" }}
        />
        <DisconnectButton
          style={{ padding: "8px 16px", borderRadius: 9999, background: "rgba(239,68,68,0.15)", color: "#f87171", fontSize: 12, cursor: "pointer", border: "none" }}
        >
          End Call
        </DisconnectButton>
      </div>
    </div>
  );
}

function AltMedicineCallWindow({
  traditionKey,
  tradition,
  onClose,
}: {
  traditionKey: TraditionKey;
  tradition: TraditionData;
  onClose: () => void;
}) {
  const [conn, setConn] = useState<{ serverUrl: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const roomNameRef = useRef(`altmed-${traditionKey}-${Date.now()}`);

  useEffect(() => {
    fetch("/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room_name: roomNameRef.current, participant_name: "user" }),
    })
      .then((r) => r.json())
      .then((data) => setConn({ serverUrl: data.serverUrl, token: data.participantToken }))
      .catch(() => setError("Failed to connect to agent"));
  }, []);

  return (
    <div style={{
      position: "fixed", bottom: 24, right: 24, width: 300, zIndex: 1000,
      background: "#0f1623",
      border: `1px solid ${tradition.color}50`,
      borderRadius: 16,
      boxShadow: `0 8px 32px ${tradition.color}18, 0 4px 12px rgba(0,0,0,0.6)`,
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        padding: "12px 16px",
        display: "flex", alignItems: "center", gap: 10,
        borderBottom: `1px solid ${tradition.color}20`,
        background: `linear-gradient(135deg, ${tradition.color}10, transparent)`,
      }}>
        <span style={{ fontSize: 22 }}>{tradition.emoji}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: "#e2e8f0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {tradition.label}
          </div>
          <div style={{ fontSize: 11, color: tradition.color, marginTop: 1 }}>Wellness Educator</div>
        </div>
        <button
          onClick={onClose}
          style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: 2, flexShrink: 0 }}
        >
          ×
        </button>
      </div>

      {/* Body */}
      {error ? (
        <div style={{ padding: 20, color: "#f87171", fontSize: 12, textAlign: "center" }}>{error}</div>
      ) : !conn ? (
        <div style={{ padding: 28, textAlign: "center", color: "#64748b", fontSize: 12 }}>
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
          <CallContent tradition={tradition} onClose={onClose} />
          <RoomAudioRenderer />
        </LiveKitRoom>
      )}
    </div>
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
  const [mapError, setMapError] = useState<string | null>(null);
  const [callOpen, setCallOpen] = useState(false);

  // Load Mapbox (client-only, defensive)
  useEffect(() => {
    if (typeof window === "undefined" || !mapRef.current) return;

    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!token) {
      console.warn("[alt-medicine] NEXT_PUBLIC_MAPBOX_TOKEN missing");
      setMapError("Map token not configured. Tradition cards still work.");
      return;
    }

    // Inject mapbox CSS once
    if (!document.getElementById("mapbox-css")) {
      const link = document.createElement("link");
      link.id = "mapbox-css";
      link.rel = "stylesheet";
      link.href = "https://api.mapbox.com/mapbox-gl-js/v3.12.0/mapbox-gl.css";
      document.head.appendChild(link);
    }

    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let map: any = null;

    (async () => {
      try {
        const mb = await import("mapbox-gl");
        if (cancelled || !mapRef.current) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mgl: any = mb.default;
        mgl.accessToken = token;

        map = new mgl.Map({
          container: mapRef.current,
          style: "mapbox://styles/mapbox/dark-v11",
          center: [20, 20],
          zoom: 1.8,
        });

        map.on("error", (e: { error?: { message?: string } }) => {
          console.error("[mapbox]", e.error?.message ?? e);
        });

        map.on("load", () => {
          if (cancelled) return;
          try { map.setFog({ color: "rgba(10,12,20,0.9)", "high-color": "rgba(8,12,20,0.7)", "horizon-blend": 0.05 }); } catch { /* fog optional */ }

          (Object.entries(TRADITIONS) as [TraditionKey, TraditionData][]).forEach(([key, t]) => {
            const el = document.createElement("div");
            el.style.cssText = `width:40px;height:40px;background:${t.color};border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;cursor:pointer;border:2px solid rgba(255,255,255,0.25);box-shadow:0 0 14px ${t.color}70, 0 0 0 3px ${t.color}20;transition:transform 0.15s;`;
            el.textContent = t.emoji;
            el.title = t.label;
            el.onmouseenter = () => { el.style.transform = "scale(1.15)"; };
            el.onmouseleave = () => { el.style.transform = "scale(1)"; };
            el.onclick = () => { selectTradition(key, map); };

            new mgl.Marker({ element: el })
              .setLngLat([...t.coords] as [number, number])
              .addTo(map);
          });

          setMapLoaded(true);
          mapInstanceRef.current = map;
        });
      } catch (e) {
        console.error("[alt-medicine] map init failed", e);
        if (!cancelled) setMapError(e instanceof Error ? e.message : "Map failed to load");
      }
    })();

    return () => {
      cancelled = true;
      try { map?.remove(); } catch { /* ignore */ }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const selectTradition = (key: TraditionKey, map: any) => {
    const t = TRADITIONS[key];
    map.flyTo({ center: t.coords as [number, number], zoom: t.zoom, duration: 2000, essential: true });
    setSelected(key);
    setCallOpen(false); // close any existing call when switching
  };

  const handleCardClick = (key: TraditionKey) => {
    const map = mapInstanceRef.current;
    if (!map) { setSelected(key); return; }
    selectTradition(key, map);
  };

  const tradition = selected ? TRADITIONS[selected] : null;

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{ padding: "16px 24px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 16 }}>
        <a href={`/dashboard?run_id=${runId}`} style={{ color: "#64748b", fontSize: 14, textDecoration: "none" }}>← Dashboard</a>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>🌍 Global Healing Map</h1>
        <span style={{ marginLeft: 8, fontSize: 13, color: "#64748b" }}>Click a pin or tradition to explore · then talk to an AI agent</span>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* Map */}
        <div style={{ flex: 1, position: "relative" }}>
          <div ref={mapRef} style={{ position: "absolute", inset: 0 }} />
          {!mapLoaded && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)", color: mapError ? "#f87171" : "#64748b", padding: 24, textAlign: "center" }}>
              {mapError ?? "Loading global healing map…"}
            </div>
          )}
        </div>

        {/* Side panel */}
        <div style={{ width: 340, background: "var(--surface)", borderLeft: "1px solid var(--border)", overflowY: "auto" }}>
          {tradition && selected ? (
            <div style={{ padding: 24 }}>
              <div style={{ fontSize: 36, marginBottom: 8 }}>{tradition.emoji}</div>
              <h2 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 700 }}>{tradition.label}</h2>
              <div style={{ height: 3, borderRadius: 2, background: tradition.color, marginBottom: 16, width: 48 }} />
              <p style={{ color: "#94a3b8", fontSize: 13, lineHeight: 1.7, marginBottom: 20 }}>{tradition.description}</p>
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 12, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Common Practices</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {tradition.practices.map((p) => (
                    <span key={p} style={{ padding: "4px 10px", borderRadius: 9999, background: tradition.color + "15", color: tradition.color, fontSize: 12 }}>{p}</span>
                  ))}
                </div>
              </div>

              {/* Talk to Agent button */}
              <button
                onClick={() => setCallOpen(true)}
                style={{
                  width: "100%", padding: "12px 16px", borderRadius: 12,
                  background: `linear-gradient(135deg, ${tradition.color}25, ${tradition.color}10)`,
                  border: `1px solid ${tradition.color}50`,
                  color: tradition.color, fontWeight: 700, fontSize: 14,
                  cursor: "pointer", marginBottom: 12,
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                }}
              >
                <span style={{ fontSize: 16 }}>🎙️</span>
                Talk to {tradition.label} Agent
              </button>

              <div style={{ padding: "10px 14px", background: "rgba(255,255,255,0.03)", borderRadius: 8, fontSize: 12, color: "#64748b", lineHeight: 1.6 }}>
                ⚕️ This is wellness education only. Consult a licensed practitioner before starting any traditional medicine regimen.
              </div>
            </div>
          ) : (
            <div style={{ padding: 24 }}>
              <div style={{ fontSize: 13, color: "#64748b", marginBottom: 20 }}>Choose a healing tradition to explore:</div>
              {(Object.entries(TRADITIONS) as [TraditionKey, TraditionData][]).map(([key, t]) => (
                <button
                  key={key}
                  onClick={() => handleCardClick(key)}
                  style={{ width: "100%", background: "none", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 16px", marginBottom: 10, cursor: "pointer", textAlign: "left", display: "flex", alignItems: "center", gap: 12 }}
                >
                  <span style={{ fontSize: 24 }}>{t.emoji}</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14, color: "#e2e8f0" }}>{t.label}</div>
                    <div style={{ fontSize: 12, color: t.color, marginTop: 2 }}>{key}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Floating call window */}
      {callOpen && selected && tradition && (
        <AltMedicineCallWindow
          traditionKey={selected}
          tradition={tradition}
          onClose={() => setCallOpen(false)}
        />
      )}
    </div>
  );
}
