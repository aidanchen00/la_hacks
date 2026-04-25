"use client";

import { useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { getRun, listRuns, type RunStatus, type RoutingDecision, type RunSummary } from "@/lib/api";
import { Suspense } from "react";

const PATH_CONFIG = {
  doctor: { icon: "🏥", label: "Doctor Appointment", desc: "Search for available providers and book appointments", color: "#22d3ee" },
  pharmacy: { icon: "💊", label: "Pharmacy / OTC", desc: "Find medications and wellness products", color: "#a78bfa" },
  mental_health: { icon: "🌊", label: "Mental Wellness", desc: "Memory-world experience and emotional support", color: "#34d399" },
  alt_medicine: { icon: "🌿", label: "Alternative Medicine", desc: "Explore traditional healing practices globally", color: "#f59e0b" },
  self_care: { icon: "✨", label: "Self-Care Resources", desc: "Education and wellness lifestyle recommendations", color: "#fb923c" },
};

function UrgencyPill({ urgency }: { urgency: string }) {
  const labels: Record<string, string> = { emergency: "🚨 Emergency", urgent: "⚡ Urgent", routine: "📅 Routine", wellness: "🌱 Wellness" };
  return (
    <span className={`pill pill-${urgency}`}>{labels[urgency] ?? urgency}</span>
  );
}

function RouteCard({ path, onClick, recommended }: { path: keyof typeof PATH_CONFIG; onClick: () => void; recommended?: boolean }) {
  const cfg = PATH_CONFIG[path];
  return (
    <button onClick={onClick} style={{
      background: recommended ? `rgba(${cfg.color === "#22d3ee" ? "34,211,238" : cfg.color === "#a78bfa" ? "167,139,250" : cfg.color === "#34d399" ? "52,211,153" : cfg.color === "#f59e0b" ? "245,158,11" : "251,146,60"},0.08)` : "var(--surface)",
      border: `1px solid ${recommended ? cfg.color + "40" : "var(--border)"}`,
      borderRadius: 16, padding: "20px 24px", cursor: "pointer", textAlign: "left",
      transition: "all 0.2s", width: "100%",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ fontSize: 32 }}>{cfg.icon}</div>
        {recommended && <span style={{ fontSize: 11, fontWeight: 700, color: cfg.color, background: cfg.color + "20", borderRadius: 9999, padding: "3px 10px", letterSpacing: "0.05em" }}>RECOMMENDED</span>}
      </div>
      <div style={{ marginTop: 12, fontWeight: 700, fontSize: 16, color: "#e2e8f0" }}>{cfg.label}</div>
      <div style={{ marginTop: 4, fontSize: 13, color: "#64748b" }}>{cfg.desc}</div>
    </button>
  );
}

const URGENCY_COLORS: Record<string, string> = {
  emergency: "#f87171", urgent: "#fb923c", routine: "#22d3ee", wellness: "#34d399",
};
const PATH_ICONS: Record<string, string> = {
  doctor: "🏥", pharmacy: "💊", mental_health: "🌊", alt_medicine: "🌿", self_care: "✨",
};

function PastIntakesList() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const router = useRouter();

  useEffect(() => {
    listRuns()
      .then((data) => { if (Array.isArray(data)) setRuns(data); })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div style={{ marginBottom: 24, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Past Intakes</h2>
          <p style={{ margin: "4px 0 0", color: "#64748b", fontSize: 14 }}>Select a session to view your care plan.</p>
        </div>
        <a href="/" className="btn-primary" style={{ textDecoration: "none", fontSize: 14, padding: "10px 20px" }}>
          + New Intake
        </a>
      </div>

      {loading && (
        <div style={{ color: "#64748b", textAlign: "center", padding: 60 }}>Loading past intakes…</div>
      )}

      {!loading && error && (
        <div style={{ color: "#f87171", textAlign: "center", padding: 60 }}>
          Could not load past intakes — make sure the API server is running.
        </div>
      )}

      {!loading && !error && runs.length === 0 && (
        <div style={{ textAlign: "center", padding: 60 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🩺</div>
          <p style={{ color: "#64748b", marginBottom: 20 }}>No past intakes yet. Start a voice session to get your care plan.</p>
          <a href="/" className="btn-primary" style={{ textDecoration: "none", display: "inline-block" }}>Start Voice Intake</a>
        </div>
      )}

      {!loading && !error && runs.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {runs.map((run) => {
            const label = run.rd_summary ?? run.intake_summary ?? run.instruction ?? "Intake session";
            const icon = PATH_ICONS[run.recommended_path ?? ""] ?? "🩺";
            const color = URGENCY_COLORS[run.urgency ?? ""] ?? "#64748b";
            const date = new Date(run.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
            return (
              <button
                key={run.id}
                onClick={() => router.push(`/dashboard?run_id=${run.id}`)}
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: 14,
                  padding: "16px 18px",
                  cursor: "pointer",
                  textAlign: "left",
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  width: "100%",
                  transition: "border-color 0.15s",
                }}
              >
                <span style={{ fontSize: 24, flexShrink: 0 }}>{icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, color: "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>
                    {label.length > 90 ? label.slice(0, 90) + "…" : label}
                  </div>
                  <div style={{ fontSize: 12, color: "#64748b", marginTop: 3 }}>
                    {date} · {(run.recommended_path ?? "pending").replace(/_/g, " ")}
                  </div>
                </div>
                {run.urgency && (
                  <span style={{
                    fontSize: 11, fontWeight: 700, color, background: color + "20",
                    borderRadius: 9999, padding: "3px 10px", whiteSpace: "nowrap", flexShrink: 0,
                  }}>
                    {run.urgency}
                  </span>
                )}
                <span style={{ color: "#475569", fontSize: 14, flexShrink: 0 }}>→</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DashboardContent() {
  const params = useSearchParams();
  const router = useRouter();
  const runId = params.get("run_id") ?? "";
  const [run, setRun] = useState<RunStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!runId) { setLoading(false); return; }
    const poll = async () => {
      try {
        const data = await getRun(runId);
        setRun(data);
        if (data.status === "pending" || data.status === "in_progress") {
          setTimeout(poll, 2000);
        }
      } catch { setLoading(false); }
      setLoading(false);
    };
    poll();
  }, [runId]);

  const rd: RoutingDecision | null = run?.routing_decision ?? null;

  const navigate = (path: string) => {
    const routes: Record<string, string> = {
      doctor: `/doctor/${runId}`,
      pharmacy: `/pharmacy/${runId}`,
      mental_health: `/memory-world/${runId}`,
      alt_medicine: `/alt-medicine/${runId}`,
      self_care: `/graph`,
    };
    router.push(routes[path] ?? "/graph");
  };

  return (
    <div style={{ minHeight: "100vh", padding: "40px 20px", maxWidth: 800, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 32 }}>
        <a href="/" style={{ color: "#64748b", fontSize: 14, textDecoration: "none" }}>← New Intake</a>
        <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800 }}>
          <span style={{ color: "#22d3ee" }}>Care</span>Flow Dashboard
        </h1>
        <button onClick={() => router.push("/graph")} style={{ marginLeft: "auto", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 9999, padding: "8px 16px", color: "#94a3b8", fontSize: 13, cursor: "pointer" }}>
          Knowledge Graph →
        </button>
      </div>

      {loading ? (
        <div style={{ color: "#64748b", textAlign: "center", padding: 80 }}>Loading your care plan…</div>
      ) : !run && !runId ? (
        <PastIntakesList />

      ) : (
        <>
          {/* Intake summary */}
          <div className="card" style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
              <span style={{ fontWeight: 700, fontSize: 16 }}>Intake Summary</span>
              {rd && <UrgencyPill urgency={rd.urgency} />}
              {run?.status === "pending" && <span className="pill" style={{ background: "rgba(100,116,139,0.15)", color: "#64748b" }}>Analyzing…</span>}
            </div>
            <p style={{ color: "#94a3b8", margin: 0, lineHeight: 1.6 }}>
              {rd?.summary ?? run?.intake_summary ?? "Your intake is being processed by the CareFlow agent…"}
            </p>
            {rd?.next_actions && rd.next_actions.length > 0 && (
              <ul style={{ marginTop: 16, paddingLeft: 20, color: "#64748b", lineHeight: 1.8 }}>
                {rd.next_actions.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            )}
            {rd?.disclaimers && rd.disclaimers.length > 0 && (
              <div style={{ marginTop: 16, padding: "10px 14px", background: "rgba(245,158,11,0.06)", borderRadius: 8, fontSize: 12, color: "#92400e", lineHeight: 1.6 }}>
                {rd.disclaimers.join(" ")}
              </div>
            )}
          </div>

          {/* Emergency alert */}
          {rd?.urgency === "emergency" && (
            <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 12, padding: "16px 20px", marginBottom: 24, color: "#f87171", fontWeight: 600 }}>
              🚨 Emergency symptoms detected. Please call <strong>911</strong> or go to your nearest emergency room immediately. Do not rely on this tool for emergency care.
            </div>
          )}

          {/* Specialist cards */}
          <div style={{ marginBottom: 16, fontWeight: 600, fontSize: 14, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.08em" }}>Choose Your Care Path</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
            {(["doctor", "pharmacy", "mental_health", "alt_medicine"] as const).map((path) => (
              <RouteCard
                key={path}
                path={path}
                recommended={rd?.recommended_path === path}
                onClick={() => navigate(path)}
              />
            ))}
          </div>

          <div style={{ marginTop: 24, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <button onClick={() => router.push("/graph")} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 16, cursor: "pointer", color: "#94a3b8", fontSize: 14 }}>
              🔮 View Knowledge Graph
            </button>
            <button onClick={() => router.push("/")} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 16, cursor: "pointer", color: "#94a3b8", fontSize: 14 }}>
              🎙️ New Voice Intake
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<div style={{ color: "#64748b", padding: 80, textAlign: "center" }}>Loading…</div>}>
      <DashboardContent />
    </Suspense>
  );
}
