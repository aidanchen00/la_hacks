"use client";

import { useEffect, useState, useRef } from "react";
import { useParams } from "next/navigation";
import { getRun } from "@/lib/api";
import { motion } from "motion/react";

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

  const statusDot = (s: SessionInfo) =>
    s.done ? "#16A34A" : s.status === "error" ? "#DC2626" : "#D97706";

  const statusLabel = (s: SessionInfo) =>
    s.done ? "Complete" : s.status === "error" ? "Failed" : "Searching…";

  return (
    <div className="min-h-screen bg-[#F4F1EA]">
      <div className="px-6 py-8 max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <a
            href={`/dashboard?run_id=${runId}`}
            className="text-[#1F3A2E] text-sm font-medium hover:opacity-70 transition-opacity"
          >
            ← Dashboard
          </a>
          <h1 className="font-serif text-[#1F3A2E] text-2xl font-medium">
            Pharmacy & Wellness Products
          </h1>
        </div>

        {/* Disclaimer */}
        <div className="bg-[#EFEAE0] border border-[#1F3A2E]/10 rounded-2xl px-5 py-3 mb-4 text-sm text-[#6B7280]">
          For educational purposes only. Consult a licensed pharmacist or doctor before purchasing any medication.
        </div>

        {/* Doctor approval warning */}
        {requiresDoctorApproval && (
          <div className="bg-[#FEE2E2] border border-[#DC2626]/20 rounded-2xl px-5 py-4 mb-6 text-sm text-[#DC2626]">
            <strong>Doctor Approval Required</strong> — Your intake indicates prescription-only items may be needed.
            Please consult a licensed physician before purchasing medications. Ordering is disabled for your safety.
          </div>
        )}

        {!started ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-[#EFEAE0] rounded-2xl p-6 max-w-md"
          >
            <h2 className="font-serif text-[#1F3A2E] text-xl font-medium mb-6">
              Search Wellness Products
            </h2>

            <div className="mb-6">
              <label className="block text-sm text-[#6B7280] mb-2">What are you looking for?</label>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                disabled={requiresDoctorApproval}
                className="w-full bg-[#F4F1EA] border border-[#1F3A2E]/20 rounded-xl px-4 py-3 text-[#3D3D3D] text-sm focus:outline-none focus:border-[#1F3A2E]/50 disabled:opacity-50"
              />
            </div>

            <motion.button
              onClick={startSearch}
              disabled={loading || requiresDoctorApproval}
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.99 }}
              className="w-full bg-[#1F3A2E] text-white py-3.5 rounded-full font-medium text-sm hover:bg-[#2A4D3D] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {requiresDoctorApproval
                ? "Requires Doctor Approval"
                : loading
                  ? "Launching agents…"
                  : "Search CVS · Walgreens · GoodRx"}
            </motion.button>
          </motion.div>
        ) : (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <p className="text-[#6B7280] text-sm mb-4">
              Searching for <strong className="text-[#3D3D3D]">{query}</strong> across pharmacies
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
                      style={{ backgroundColor: statusDot(s) }}
                    />
                    <span className="font-medium text-[#1F3A2E] text-sm">{s.agent}</span>
                    <span className="ml-auto text-xs text-[#6B7280]">{statusLabel(s)}</span>
                  </div>
                  {s.liveUrl ? (
                    <iframe
                      src={s.liveUrl}
                      className="w-full border-none"
                      style={{ height: 340 }}
                      title={`${s.agent} browser`}
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
