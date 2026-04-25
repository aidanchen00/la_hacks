"use client";

import { useEffect, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";

interface SessionInfo {
  agent: string;
  sessionId: string;
  liveUrl: string;
  status: string;
  error?: string;
  done?: boolean;
}

const FIXTURE_SESSIONS: SessionInfo[] = [
  { agent: "ZocDoc", sessionId: "mock-1", liveUrl: "", status: "running" },
  { agent: "Healthgrades", sessionId: "mock-2", liveUrl: "", status: "running" },
  { agent: "Solv", sessionId: "mock-3", liveUrl: "", status: "running" },
];

export default function DoctorPage() {
  const { runId } = useParams<{ runId: string }>();
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [specialty, setSpecialty] = useState("primary care");
  const [location, setLocation] = useState("Los Angeles, CA");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startSearch = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/browser/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "doctor", query: specialty, location }),
      });
      const data = await res.json();
      setSessions(data.sessions ?? FIXTURE_SESSIONS);
      setStarted(true);
    } catch {
      setSessions(FIXTURE_SESSIONS);
      setStarted(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!started || !sessions.length) return;
    const activeSessions = sessions.filter((s) => s.sessionId && !s.done && s.status !== "error");
    if (!activeSessions.length) return;

    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/api/browser/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionIds: activeSessions.map((s) => ({ agent: s.agent, sessionId: s.sessionId })) }),
        });
        const data = await res.json();
        setSessions((prev) =>
          prev.map((s) => {
            const updated = data.sessions?.find((u: SessionInfo) => u.sessionId === s.sessionId);
            return updated ? { ...s, ...updated } : s;
          })
        );
      } catch { /* ignore */ }
    }, 5000);

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [started, sessions]);

  useEffect(() => {
    return () => {
      const ids = sessions.map((s) => s.sessionId).filter(Boolean);
      if (ids.length) {
        fetch("/api/browser/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionIds: ids }) }).catch(() => {});
      }
    };
  }, [sessions]);

  const statusColor = (s: SessionInfo) =>
    s.done ? "#34d399" : s.status === "error" ? "#f87171" : "#22d3ee";

  return (
    <div style={{ minHeight: "100vh", padding: "32px 24px", maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 28 }}>
        <a href={`/dashboard?run_id=${runId}`} style={{ color: "#64748b", fontSize: 14, textDecoration: "none" }}>← Dashboard</a>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>🏥 Doctor Appointment Search</h1>
      </div>

      <div style={{ background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.15)", borderRadius: 10, padding: "12px 16px", marginBottom: 24, fontSize: 13, color: "#f87171" }}>
        ⚕️ For wellness care navigation only. Always verify provider credentials. In emergencies, call 911.
      </div>

      {!started ? (
        <div className="card" style={{ maxWidth: 480 }}>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 20 }}>Search for Providers</div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 13, color: "#64748b", display: "block", marginBottom: 6 }}>Specialty / Concern</label>
            <input
              value={specialty}
              onChange={(e) => setSpecialty(e.target.value)}
              style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 14px", color: "#e2e8f0", fontSize: 14 }}
            />
          </div>
          <div style={{ marginBottom: 20 }}>
            <label style={{ fontSize: 13, color: "#64748b", display: "block", marginBottom: 6 }}>Location</label>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 14px", color: "#e2e8f0", fontSize: 14 }}
            />
          </div>
          <button className="btn-primary" onClick={startSearch} disabled={loading}>
            {loading ? "Launching agents…" : "Launch Search Agents (×3)"}
          </button>
        </div>
      ) : (
        <>
          <div style={{ marginBottom: 16, fontSize: 13, color: "#64748b" }}>
            {sessions.filter((s) => s.done).length}/{sessions.length} agents complete · Searching for <strong>{specialty}</strong> in <strong>{location}</strong>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
            {sessions.map((s) => (
              <div key={s.agent} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, overflow: "hidden" }}>
                <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--border)" }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor(s), boxShadow: `0 0 6px ${statusColor(s)}`, display: "inline-block" }} />
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{s.agent}</span>
                  <span style={{ marginLeft: "auto", fontSize: 12, color: "#64748b" }}>{s.done ? "complete" : s.status === "error" ? "failed" : "searching…"}</span>
                </div>
                {s.liveUrl ? (
                  <iframe src={s.liveUrl} style={{ width: "100%", height: 340, border: "none" }} title={`${s.agent} browser session`} />
                ) : (
                  <div style={{ height: 340, display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b", fontSize: 13 }}>
                    {s.error ? `Error: ${s.error}` : "Waiting for live session…"}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
