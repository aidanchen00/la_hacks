"use client";

import { useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { getRun, listRuns, type RunStatus, type RoutingDecision, type RunSummary } from "@/lib/api";
import { FIXTURE_ROUTING_DECISION } from "@/fixtures";
import { Suspense } from "react";
import { motion } from "motion/react";
import { Plus, Bookmark, Phone, Navigation, AlertCircle } from "lucide-react";
import LanguagePicker from "@/app/components/LanguagePicker";

const PATH_CONFIG = {
  doctor: {
    label: "Doctor Appointment",
    desc: "Search for available providers and book appointments",
    icon: "🏥",
    color: "#1F3A2E",
  },
  pharmacy: {
    label: "Pharmacy & Wellness",
    desc: "Find medications and OTC wellness products",
    icon: "💊",
    color: "#2A4D3D",
  },
  mental_health: {
    label: "Mental Wellness",
    desc: "Memory-world experience and emotional support",
    icon: "🌊",
    color: "#1F3A2E",
  },
  alt_medicine: {
    label: "Alternative Medicine",
    desc: "Explore traditional healing practices globally",
    icon: "🌿",
    color: "#2A4D3D",
  },
  self_care: {
    label: "Self-Care Resources",
    desc: "Education and wellness lifestyle recommendations",
    icon: "✨",
    color: "#1F3A2E",
  },
};

const urgencyConfig: Record<string, { color: string; bg: string; text: string }> = {
  emergency: { color: "#DC2626", bg: "#FEE2E2", text: "EMERGENCY" },
  urgent:    { color: "#EA580C", bg: "#FFEDD5", text: "URGENT" },
  routine:   { color: "#D97706", bg: "#FEF3C7", text: "ROUTINE" },
  wellness:  { color: "#16A34A", bg: "#DCFCE7", text: "WELLNESS" },
};

function UrgencyBadge({ urgency }: { urgency: string }) {
  const cfg = urgencyConfig[urgency] ?? { color: "#6B7280", bg: "#F3F4F6", text: urgency.toUpperCase() };
  return (
    <div
      className="inline-flex items-center gap-2 px-4 py-2 rounded-full"
      style={{ backgroundColor: cfg.bg, color: cfg.color }}
    >
      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: cfg.color }} />
      <span className="font-bold text-sm uppercase tracking-wide">{cfg.text}</span>
    </div>
  );
}

function RouteCard({
  path,
  onClick,
  recommended,
}: {
  path: keyof typeof PATH_CONFIG;
  onClick: () => void;
  recommended?: boolean;
}) {
  const cfg = PATH_CONFIG[path];
  return (
    <motion.button
      onClick={onClick}
      whileHover={{ scale: 1.01 }}
      whileTap={{ scale: 0.99 }}
      className="w-full text-left bg-[#EFEAE0] rounded-2xl p-5 border transition-colors min-h-[88px]"
      style={{
        borderColor: recommended ? "rgba(31,58,46,0.4)" : "rgba(31,58,46,0.1)",
        borderWidth: recommended ? 2 : 1,
      }}
    >
      <div className="flex items-start justify-between mb-3">
        <span className="text-2xl">{cfg.icon}</span>
        {recommended && (
          <span className="text-xs font-bold text-[#1F3A2E] bg-[#1F3A2E]/10 rounded-full px-2.5 py-1 uppercase tracking-wide">
            Recommended
          </span>
        )}
      </div>
      <p className="font-serif text-[#1F3A2E] text-lg font-medium mb-1">{cfg.label}</p>
      <p className="text-[#6B7280] text-sm leading-relaxed">{cfg.desc}</p>
    </motion.button>
  );
}

function DashboardContent() {
  const params = useSearchParams();
  const router = useRouter();
  const runId = params.get("run_id") ?? "";
  const isDemo = runId === "demo";
  const [run, setRun] = useState<RunStatus | null>(null);
  const [loading, setLoading] = useState(!isDemo);
  const [pastRuns, setPastRuns] = useState<RunSummary[]>([]);
  const [pastLoading, setPastLoading] = useState(false);

  useEffect(() => {
    if (isDemo) {
      setRun({
        id: "demo",
        status: "complete",
        intake_summary: FIXTURE_ROUTING_DECISION.summary,
        routing_decision: FIXTURE_ROUTING_DECISION as RoutingDecision,
        events_count: 0,
      });
      return;
    }
    if (!runId) {
      setLoading(false);
      setPastLoading(true);
      listRuns()
        .then((data) => { if (Array.isArray(data)) setPastRuns(data); })
        .catch(() => {})
        .finally(() => setPastLoading(false));
      return;
    }
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
  }, [runId, isDemo]);

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
    <div className="min-h-screen bg-[#F4F1EA]">
      {/* Emergency banner */}
      {rd?.urgency === "emergency" && (
        <div className="bg-[#DC2626] text-white py-4 px-4 sm:px-6 text-center">
          <div className="max-w-2xl mx-auto flex items-center justify-center gap-2 mb-2">
            <AlertCircle className="w-5 h-5" />
            <span className="font-bold uppercase tracking-wide">Medical Emergency</span>
          </div>
          <p className="text-sm mb-3">Call 911 or go to the nearest emergency room immediately</p>
          <a
            href="tel:911"
            className="inline-flex items-center justify-center bg-white text-[#DC2626] font-bold rounded-full px-8 min-h-[52px] text-base hover:bg-red-50 transition-colors"
          >
            Call 911 Now
          </a>
        </div>
      )}

      <div className="px-4 sm:px-6 py-6 sm:py-8 max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <a href="/" className="text-[#1F3A2E] text-sm font-medium hover:opacity-70 transition-opacity">
            ← New Intake
          </a>
          <div className="ml-auto flex items-center gap-2">
            <LanguagePicker />
            <button
              onClick={() => router.push("/graph")}
              className="text-sm text-[#6B7280] border border-[#1F3A2E]/20 rounded-full px-4 py-2 hover:border-[#1F3A2E]/40 transition-colors"
            >
              Knowledge Graph →
            </button>
          </div>
        </div>

        {loading ? (
          <motion.div
            animate={{ opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 2, repeat: Infinity }}
            className="flex items-center justify-center min-h-[70vh]"
          >
            <p className="font-serif text-[#1F3A2E] text-2xl font-medium text-center">
              Analyzing your intake…
            </p>
          </motion.div>
        ) : !run && !runId ? (
          <div>
            <h1 className="font-serif text-[#1F3A2E] text-2xl sm:text-[36px] leading-[1.3] font-medium mb-3">
              Your intake history
            </h1>
            <p className="text-[#6B7280] mb-8">
              Pick a past session to view its care plan, or start a new intake.
            </p>

            {pastLoading ? (
              <p className="text-[#6B7280] text-sm">Loading…</p>
            ) : pastRuns.length === 0 ? (
              <div className="bg-[#EFEAE0] rounded-2xl p-8 text-center border border-[#1F3A2E]/10">
                <p className="font-serif text-[#1F3A2E] text-xl mb-3">No past intakes yet.</p>
                <p className="text-[#6B7280] text-sm mb-6">
                  Start a voice or text intake to get a personalized care plan.
                </p>
                <a
                  href="/"
                  className="inline-block bg-[#1F3A2E] text-white py-3 px-8 rounded-full font-medium hover:bg-[#2A4D3D] transition-colors"
                >
                  Start Intake
                </a>
              </div>
            ) : (
              <div className="space-y-3">
                {pastRuns.map((r) => {
                  const label = r.rd_summary ?? r.intake_summary ?? r.instruction ?? "Intake session";
                  const date = new Date(r.created_at).toLocaleDateString(undefined, {
                    month: "short", day: "numeric", year: "numeric",
                  });
                  const cfg = r.urgency ? urgencyConfig[r.urgency] : null;
                  const pathLabel = r.recommended_path
                    ? PATH_CONFIG[r.recommended_path as keyof typeof PATH_CONFIG]?.label ?? r.recommended_path.replace(/_/g, " ")
                    : "Pending";
                  return (
                    <motion.button
                      key={r.id}
                      onClick={() => router.push(`/dashboard?run_id=${r.id}`)}
                      whileHover={{ scale: 1.005 }}
                      whileTap={{ scale: 0.995 }}
                      className="w-full text-left bg-[#EFEAE0] rounded-2xl p-5 border border-[#1F3A2E]/10 hover:border-[#1F3A2E]/30 transition-colors"
                    >
                      <div className="flex items-start gap-3 mb-2">
                        <p className="text-[#3D3D3D] text-sm leading-relaxed flex-1 line-clamp-2">
                          {label.length > 120 ? label.slice(0, 120) + "…" : label}
                        </p>
                        {cfg && (
                          <span
                            className="text-xs font-bold px-2.5 py-1 rounded-full whitespace-nowrap flex-shrink-0 uppercase tracking-wide"
                            style={{ color: cfg.color, backgroundColor: cfg.bg }}
                          >
                            {cfg.text}
                          </span>
                        )}
                      </div>
                      <p className="text-[#6B7280] text-xs">
                        {date} · {pathLabel}
                      </p>
                    </motion.button>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Triage assessment */}
            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-10"
            >
              {rd && <UrgencyBadge urgency={rd.urgency} />}
              {run?.status === "pending" && (
                <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-[#F3F4F6] text-[#6B7280] text-sm font-bold uppercase tracking-wide">
                  Analyzing…
                </div>
              )}

              <h1 className="font-serif text-[#1F3A2E] text-2xl sm:text-[36px] leading-[1.3] font-medium mt-4 mb-4">
                {rd?.summary ?? (run?.intake_summary ? "Your care plan is ready." : "Your intake is being processed…")}
              </h1>

              {/* Suggested next step */}
              {rd?.next_actions && rd.next_actions.length > 0 && (
                <div className="bg-[#EFEAE0] rounded-2xl p-5 border-l-4 border-[#1F3A2E]">
                  <p className="text-[#1F3A2E] font-medium mb-2">Suggested next steps</p>
                  <ul className="space-y-1.5">
                    {rd.next_actions.map((action, i) => (
                      <li key={i} className="text-[#3D3D3D] text-sm leading-relaxed">
                        • {action}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Summary details */}
              {run?.intake_summary && !rd && (
                <div className="bg-[#EFEAE0] rounded-2xl p-5 border-l-4 border-[#1F3A2E]">
                  <p className="text-[#1F3A2E] font-medium mb-1">What you shared</p>
                  <p className="text-[#3D3D3D] text-base leading-relaxed">{run.intake_summary}</p>
                </div>
              )}

              {/* Disclaimers */}
              {rd?.disclaimers && rd.disclaimers.length > 0 && (
                <p className="text-[#6B7280] text-xs mt-4 italic">
                  {rd.disclaimers.join(" ")}
                </p>
              )}
            </motion.div>

            {/* Care path cards */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="mb-10"
            >
              <h2 className="font-serif text-[#1F3A2E] text-2xl font-medium mb-4">
                Choose your care path
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                {(["doctor", "pharmacy", "mental_health", "alt_medicine"] as const).map((path) => (
                  <RouteCard
                    key={path}
                    path={path}
                    recommended={rd?.recommended_path === path}
                    onClick={() => navigate(path)}
                  />
                ))}
              </div>
            </motion.div>

            {/* Find care nearby section */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="mb-24"
            >
              <h2 className="font-serif text-[#1F3A2E] text-2xl font-medium mb-4">
                Find care nearby
              </h2>
              <div className="bg-[#EFEAE0] rounded-2xl p-6 space-y-4">
                <div className="flex items-center justify-between pb-4 border-b border-[#1F3A2E]/10">
                  <div>
                    <p className="text-[#1F3A2E] font-medium">Doctor Search</p>
                    <p className="text-[#6B7280] text-sm">ZocDoc, Healthgrades, Solv</p>
                  </div>
                  <button
                    onClick={() => navigate("doctor")}
                    className="p-2 rounded-full bg-[#1F3A2E] text-white hover:bg-[#2A4D3D] transition-colors"
                  >
                    <Phone className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex items-center justify-between pb-4 border-b border-[#1F3A2E]/10">
                  <div>
                    <p className="text-[#1F3A2E] font-medium">Pharmacy Search</p>
                    <p className="text-[#6B7280] text-sm">CVS · Walgreens · GoodRx</p>
                  </div>
                  <button
                    onClick={() => navigate("pharmacy")}
                    className="p-2 rounded-full bg-[#1F3A2E] text-white hover:bg-[#2A4D3D] transition-colors"
                  >
                    <Navigation className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[#1F3A2E] font-medium">Knowledge Graph</p>
                    <p className="text-[#6B7280] text-sm">Your health knowledge map</p>
                  </div>
                  <button
                    onClick={() => router.push("/graph")}
                    className="p-2 rounded-full bg-[#1F3A2E] text-white hover:bg-[#2A4D3D] transition-colors"
                  >
                    <Navigation className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </div>

      {/* Persistent bottom bar */}
      <div
        className="fixed bottom-0 left-0 right-0 bg-[#F4F1EA] border-t border-[#1F3A2E]/10 px-4 sm:px-6 pt-3 shadow-lg"
        style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom, 1rem))" }}
      >
        <div className="max-w-2xl mx-auto flex gap-3">
          <button
            onClick={() => router.push("/")}
            className="flex-1 flex items-center justify-center gap-2 bg-transparent border-2 border-[#1F3A2E] text-[#1F3A2E] py-3 px-5 rounded-full font-medium text-sm hover:bg-[#1F3A2E]/5 transition-colors min-h-[48px]"
          >
            <Plus className="w-4 h-4" />
            <span>New conversation</span>
          </button>
          <button
            onClick={() => router.push("/?history=true")}
            className="flex-1 flex items-center justify-center gap-2 bg-[#1F3A2E] text-white py-3 px-5 rounded-full font-medium text-sm hover:bg-[#2A4D3D] transition-colors min-h-[48px]"
          >
            <Bookmark className="w-4 h-4" />
            <span>View history</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-[#F4F1EA] flex items-center justify-center">
        <p className="font-serif text-[#1F3A2E] text-2xl font-medium">Loading…</p>
      </div>
    }>
      <DashboardContent />
    </Suspense>
  );
}
