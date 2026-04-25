"use client";

import { useEffect, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { motion } from "motion/react";

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
        fetch("/api/browser/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionIds: ids }),
        }).catch(() => {});
      }
    };
  }, [sessions]);

  const statusDot = (s: SessionInfo) =>
    s.done ? "#16A34A" : s.status === "error" ? "#DC2626" : "#D97706";

  const statusLabel = (s: SessionInfo) =>
    s.done ? "Complete" : s.status === "error" ? "Failed" : "Searching…";

  return (
    <div className="min-h-screen bg-[#F4F1EA]">
      <div className="px-6 py-8 max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <button
            onClick={() => router.push(`/dashboard?run_id=${runId}`)}
            className="text-[#1F3A2E] text-sm font-medium hover:opacity-70 transition-opacity"
          >
            ← Dashboard
          </button>
          <h1 className="font-serif text-[#1F3A2E] text-2xl font-medium">
            Doctor Appointment Search
          </h1>
        </div>

        {/* Disclaimer */}
        <div className="bg-[#EFEAE0] border border-[#1F3A2E]/10 rounded-2xl px-5 py-3 mb-6 text-sm text-[#6B7280]">
          For wellness care navigation only. Always verify provider credentials. In emergencies, call 911.
        </div>

        {!started ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-[#EFEAE0] rounded-2xl p-6 max-w-md"
          >
            <h2 className="font-serif text-[#1F3A2E] text-xl font-medium mb-6">
              Search for Providers
            </h2>

            <div className="space-y-4 mb-6">
              <div>
                <label className="block text-sm text-[#6B7280] mb-2">Specialty / Concern</label>
                <input
                  value={specialty}
                  onChange={(e) => setSpecialty(e.target.value)}
                  className="w-full bg-[#F4F1EA] border border-[#1F3A2E]/20 rounded-xl px-4 py-3 text-[#3D3D3D] text-sm focus:outline-none focus:border-[#1F3A2E]/50"
                />
              </div>
              <div>
                <label className="block text-sm text-[#6B7280] mb-2">Location</label>
                <input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  className="w-full bg-[#F4F1EA] border border-[#1F3A2E]/20 rounded-xl px-4 py-3 text-[#3D3D3D] text-sm focus:outline-none focus:border-[#1F3A2E]/50"
                />
              </div>
            </div>

            <motion.button
              onClick={startSearch}
              disabled={loading}
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.99 }}
              className="w-full bg-[#1F3A2E] text-white py-3.5 rounded-full font-medium text-sm hover:bg-[#2A4D3D] transition-colors disabled:opacity-40"
            >
              {loading ? "Launching agents…" : "Launch Search Agents (×3)"}
            </motion.button>
          </motion.div>
        ) : (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <p className="text-[#6B7280] text-sm mb-4">
              {sessions.filter((s) => s.done).length}/{sessions.length} agents complete
              · Searching for <strong className="text-[#3D3D3D]">{specialty}</strong> in{" "}
              <strong className="text-[#3D3D3D]">{location}</strong>
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {sessions.map((s) => (
                <div
                  key={s.agent}
                  className="bg-[#EFEAE0] rounded-2xl overflow-hidden border border-[#1F3A2E]/10"
                >
                  <div className="px-4 py-3 flex items-center gap-2.5 border-b border-[#1F3A2E]/10">
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: statusDot(s), boxShadow: `0 0 6px ${statusDot(s)}` }}
                    />
                    <span className="font-medium text-[#1F3A2E] text-sm">{s.agent}</span>
                    <span className="ml-auto text-xs text-[#6B7280]">{statusLabel(s)}</span>
                  </div>
                  {s.liveUrl ? (
                    <iframe
                      src={s.liveUrl}
                      className="w-full border-none"
                      style={{ height: 340 }}
                      title={`${s.agent} browser session`}
                    />
                  ) : (
                    <div className="h-[340px] flex items-center justify-center text-[#6B7280] text-sm">
                      {s.error ? `Error: ${s.error}` : "Waiting for live session…"}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}
