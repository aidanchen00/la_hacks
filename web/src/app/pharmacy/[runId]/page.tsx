"use client";

import { useEffect, useState, useRef } from "react";
import { useParams } from "next/navigation";
import { getRun } from "@/lib/api";

interface SessionInfo {
  agent: string;
  sessionId: string;
  liveUrl: string;
  status: string;
  error?: string;
  done?: boolean;
}

export default function PharmacyPage() {
  const { runId } = useParams<{ runId: string }>();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("cold and flu relief");
  const [requiresDoctorApproval, setRequiresDoctorApproval] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!runId || runId === "no-run") return;
    getRun(runId).then((run) => {
      if (run.routing_decision?.requires_doctor_approval) {
        setRequiresDoctorApproval(true);
      }
    }).catch(() => {});
  }, [runId]);

  const startSearch = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/browser/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "pharmacy", query }),
      });
      const data = await res.json();
      setSessions(data.sessions ?? []);
      setStarted(true);
    } catch {
      setStarted(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!started || !sessions.length) return;
    const active = sessions.filter((s) => s.sessionId && !s.done && s.status !== "error");
    if (!active.length) return;
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/api/browser/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionIds: active.map((s) => ({ agent: s.agent, sessionId: s.sessionId })) }),
        });
        const data = await res.json();
        setSessions((prev) => prev.map((s) => {
          const u = data.sessions?.find((x: SessionInfo) => x.sessionId === s.sessionId);
          return u ? { ...s, ...u } : s;
        }));
      } catch { /* ignore */ }
    }, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [started, sessions]);

  const statusColor = (s: SessionInfo) =>
    s.done ? "#34d399" : s.status === "error" ? "#f87171" : "#a78bfa";

  return (
    <div style={{ minHeight: "100vh", padding: "32px 24px", maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 28 }}>
        <a href={`/dashboard?run_id=${runId}`} style={{ color: "#64748b", fontSize: 14, textDecoration: "none" }}>← Dashboard</a>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>💊 Pharmacy & Wellness Products</h1>
      </div>

      {/* Disclaimers */}
      <div style={{ background: "rgba(167,139,250,0.06)", border: "1px solid rgba(167,139,250,0.2)", borderRadius: 10, padding: "12px 16px", marginBottom: 16, fontSize: 13, color: "#a78bfa" }}>
        ⚕️ For educational purposes only. Consult a licensed pharmacist or doctor before purchasing any medication. This tool does not process or confirm purchases.
      </div>

      {requiresDoctorApproval && (
        <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 10, padding: "14px 18px", marginBottom: 20, fontSize: 14, color: "#f87171" }}>
          🔒 <strong>Doctor Approval Required</strong> — Your intake indicates prescription-only items may be needed. Please consult a licensed physician before purchasing medications. Ordering is disabled for your safety.
        </div>
      )}

      {!started ? (
        <div className="card" style={{ maxWidth: 480 }}>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 20 }}>Search Wellness Products</div>
          <div style={{ marginBottom: 20 }}>
            <label style={{ fontSize: 13, color: "#64748b", display: "block", marginBottom: 6 }}>What are you looking for?</label>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={requiresDoctorApproval}
              style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 14px", color: "#e2e8f0", fontSize: 14, opacity: requiresDoctorApproval ? 0.5 : 1 }}
            />
          </div>
          <button className="btn-primary" onClick={startSearch} disabled={loading || requiresDoctorApproval}>
            {requiresDoctorApproval ? "Requires Doctor Approval" : loading ? "Launching agents…" : "Search CVS · Walgreens · GoodRx"}
          </button>
        </div>
      ) : (
        <>
          <div style={{ marginBottom: 16, fontSize: 13, color: "#64748b" }}>
            Searching for <strong>{query}</strong> across pharmacies
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
            {sessions.map((s) => (
              <div key={s.agent} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, overflow: "hidden" }}>
                <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--border)" }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor(s), display: "inline-block" }} />
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{s.agent}</span>
                  <span style={{ marginLeft: "auto", fontSize: 12, color: "#64748b" }}>{s.done ? "complete" : "searching…"}</span>
                </div>
                {s.liveUrl ? (
                  <iframe src={s.liveUrl} style={{ width: "100%", height: 340, border: "none" }} title={`${s.agent} browser`} />
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
