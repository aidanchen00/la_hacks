"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { getRun, listRuns, type RunStatus, type RoutingDecision, type RunSummary } from "@/lib/api";
import { FIXTURE_ROUTING_DECISION } from "@/fixtures";
import { Suspense } from "react";
import { motion } from "motion/react";
import { Plus, Bookmark, AlertCircle } from "lucide-react";
import LanguagePicker from "@/app/components/LanguagePicker";
import CostTransparency from "@/components/CostTransparency";
import RedditShareModal from "@/components/RedditShareModal";
import { useTranslate } from "@/lib/translate";

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

// MoE expert labels surfaced in the dashboard "Routed to" callout.
const EXPERT_LABEL: Record<string, string> = {
  doctor: "Doctor expert",
  alternative_medicine: "Alternative medicine expert",
  emergency: "Emergency expert",
};

// Show the "in progress" placeholder for the video / expert sections only
// when a run is recent enough that processing might still be running.
// 3 minutes matches the FastAPI poll-task budget.
function isVideoPending(run: RunStatus | null): boolean {
  if (!run || run.video_analysis || run.expert_route) return false;
  if (!run.created_at) return false;
  const ageMs = Date.now() - new Date(run.created_at).getTime();
  return ageMs >= 0 && ageMs < 3 * 60 * 1000;
}

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
  label,
  desc,
  recommendedLabel,
}: {
  path: keyof typeof PATH_CONFIG;
  onClick: () => void;
  recommended?: boolean;
  label: string;
  desc: string;
  recommendedLabel: string;
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
            {recommendedLabel}
          </span>
        )}
      </div>
      <p className="font-serif text-[#1F3A2E] text-lg font-medium mb-1">{label}</p>
      <p className="text-[#6B7280] text-sm leading-relaxed">{desc}</p>
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
  const [showRedditModal, setShowRedditModal] = useState(false);

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
        // Keep polling while:
        //   - the routing decision is still being computed, OR
        //   - the video pipeline is still working (run is recent and either
        //     analysis or expert label hasn't landed yet).
        const stillRouting =
          data.status === "pending" || data.status === "in_progress";
        const videoStillRunning =
          isVideoPending(data) ||
          (!!data.video_analysis && !data.expert_route &&
            !!data.created_at &&
            Date.now() - new Date(data.created_at).getTime() < 3 * 60 * 1000);
        if (stillRouting || videoStillRunning) {
          setTimeout(poll, 2000);
        }
      } catch { setLoading(false); }
      setLoading(false);
    };
    poll();
  }, [runId, isDemo]);

  const rd: RoutingDecision | null = run?.routing_decision ?? null;

  // Static UI strings — translated as a single batch and re-translated when the language changes.
  const STATIC_KEYS = useMemo(
    () => [
      "← New Intake",                                                                 // 0
      "Knowledge Graph →",                                                            // 1
      "Analyzing your intake…",                                                       // 2
      "Your intake history",                                                          // 3
      "Pick a past session to view its care plan, or start a new intake.",            // 4
      "No past intakes yet.",                                                         // 5
      "Start a voice or text intake to get a personalized care plan.",                // 6
      "Start Intake",                                                                 // 7
      "Loading…",                                                                     // 8
      "Analyzing…",                                                                   // 9
      "Your care plan is ready.",                                                     // 10
      "Your intake is being processed…",                                              // 11
      "Suggested next steps",                                                         // 12
      "What you shared",                                                              // 13
      "Choose your care path",                                                        // 14
      "New conversation",                                                             // 15
      "View history",                                                                 // 16
      "Recommended",                                                                  // 17
      "Pending",                                                                      // 18
      "Medical Emergency",                                                            // 19
      "Call 911 or go to the nearest emergency room immediately",                     // 20
      "Call 911 Now",                                                                 // 21
      "Doctor Appointment",                                                           // 22
      "Search for available providers and book appointments",                         // 23
      "Pharmacy & Wellness",                                                          // 24
      "Find medications and OTC wellness products",                                   // 25
      "Mental Wellness",                                                              // 26
      "Memory-world experience and emotional support",                                // 27
      "Alternative Medicine",                                                         // 28
      "Explore traditional healing practices globally",                               // 29
      "Self-Care Resources",                                                          // 30
      "Education and wellness lifestyle recommendations",                             // 31
      "Intake session",                                                               // 32
      "What's visible in your video",                                                 // 33
      "Video analysis in progress…",                                                  // 34
    ],
    [],
  );
  const t = useTranslate(STATIC_KEYS);
  const T = {
    newIntake: t[0], graph: t[1], analyzingIntake: t[2], intakeHistory: t[3],
    pickPast: t[4], noPast: t[5], startIntakeBlurb: t[6], startIntakeBtn: t[7],
    loading: t[8], analyzing: t[9], planReady: t[10], processingIntake: t[11],
    nextSteps: t[12], whatYouShared: t[13], choosePath: t[14], newConv: t[15],
    viewHistory: t[16], recommended: t[17], pending: t[18], emergencyHeader: t[19],
    emergencyMsg: t[20], call911: t[21],
    intakeSessionFallback: t[32],
    whatVisibleInVideo: t[33], videoAnalysisPending: t[34],
  };
  const PATH_T: Record<keyof typeof PATH_CONFIG, { label: string; desc: string }> = {
    doctor: { label: t[22], desc: t[23] },
    pharmacy: { label: t[24], desc: t[25] },
    mental_health: { label: t[26], desc: t[27] },
    alt_medicine: { label: t[28], desc: t[29] },
    self_care: { label: t[30], desc: t[31] },
  };

  // Headers/labels used by the Reddit share modal. Translated alongside the
  // dynamic content so the whole post matches the user's language.
  const REDDIT_HEADERS = useMemo(() => [
    "Urgency",                                                                      // 0
    "Recommended path",                                                             // 1
    "Summary",                                                                      // 2
    "Next actions",                                                                 // 3
    "References",                                                                   // 4
    "Generated by Prana, an AI wellness navigation tool. Not a medical diagnosis. For emergencies, call 911.", // 5
    "Prana intake",                                                                 // 6 — title prefix
    "My Prana intake",                                                              // 7 — fallback subtitle
    // Path-specific community CTA questions, indexed 8–12 in the order below.
    "Has anyone here dealt with similar symptoms — what made you decide it was time to see a doctor?", // 8 doctor
    "Has anyone tried OTC options for this? What actually helped?",                 // 9 pharmacy
    "Anyone else been through something similar — what helped you cope?",          // 10 mental_health
    "Has anyone here tried alternative approaches for this? Curious what worked.", // 11 alt_medicine
    "Anyone have go-to tips for managing this at home?",                           // 12 self_care
    "Looking for advice",                                                           // 13 — section header for the question
  ], []);

  // Dynamic content — summary, next actions, disclaimers, intake summary, and
  // reddit headers. Single batch keeps it to one translation request.
  const dynamicTexts = useMemo(() => {
    const arr: string[] = [];
    if (rd?.summary) arr.push(rd.summary);
    arr.push(...(rd?.next_actions ?? []));
    arr.push(...(rd?.disclaimers ?? []));
    if (run?.intake_summary) arr.push(run.intake_summary);
    arr.push(...REDDIT_HEADERS);
    return arr;
  }, [rd?.summary, rd?.next_actions, rd?.disclaimers, run?.intake_summary, REDDIT_HEADERS]);
  const tDynamic = useTranslate(dynamicTexts);
  let cursor = 0;
  const tSummary = rd?.summary ? tDynamic[cursor++] : null;
  const tNextActions = (rd?.next_actions ?? []).map(() => tDynamic[cursor++]);
  const tDisclaimers = (rd?.disclaimers ?? []).map(() => tDynamic[cursor++]);
  const tIntakeSummary = run?.intake_summary ? tDynamic[cursor++] : null;
  const tRedditHeaders = REDDIT_HEADERS.map((src, i) => tDynamic[cursor + i] ?? src);
  cursor += REDDIT_HEADERS.length;

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

  // Default body for the Reddit share modal — readable markdown summarizing
  // what Prana suggested. Uses translated copy when the user has switched
  // languages so what they share matches what they see.
  const redditDefaults = useMemo(() => {
    if (!rd) return null;
    const pathLabel = PATH_T[rd.recommended_path as keyof typeof PATH_CONFIG]?.label
      ?? PATH_CONFIG[rd.recommended_path as keyof typeof PATH_CONFIG]?.label
      ?? rd.recommended_path;
    const [
      hUrgency, hPath, hSummary, hActions, hRefs, hDisclaimer, hTitlePrefix, hTitleFallback,
      qDoctor, qPharmacy, qMental, qAlt, qSelf, hAdvice,
    ] = tRedditHeaders;
    const PATH_QUESTIONS: Record<string, string> = {
      doctor: qDoctor, pharmacy: qPharmacy, mental_health: qMental,
      alt_medicine: qAlt, self_care: qSelf,
    };
    const ctaQuestion = PATH_QUESTIONS[rd.recommended_path] ?? qSelf;
    const titleSummary = (tSummary ?? rd.summary ?? "").slice(0, 200).trim();
    const titleBase = titleSummary || `${hTitleFallback} — ${pathLabel}`;
    const title = `[${hTitlePrefix}] ${titleBase}`.slice(0, 300);

    const bodyParts: string[] = [];
    bodyParts.push(`**${hUrgency}:** ${rd.urgency} · **${hPath}:** ${pathLabel}\n`);
    if (tSummary ?? rd.summary) {
      bodyParts.push(`### ${hSummary}\n${tSummary ?? rd.summary}\n`);
    }
    if (rd.next_actions?.length) {
      bodyParts.push(`### ${hActions}`);
      bodyParts.push(rd.next_actions.map((a, i) => `- ${tNextActions[i] ?? a}`).join("\n"));
      bodyParts.push("");
    }
    if (rd.citations?.length) {
      bodyParts.push(`### ${hRefs}`);
      bodyParts.push(rd.citations.map((c) => `- [${c.condition} via ${c.source}](${c.url})`).join("\n"));
      bodyParts.push("");
    }
    bodyParts.push(`### ${hAdvice}`);
    bodyParts.push(ctaQuestion);
    bodyParts.push("");
    bodyParts.push("---");
    bodyParts.push(`_${hDisclaimer}_`);
    return { title, body: bodyParts.join("\n") };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rd, tSummary, tNextActions, tRedditHeaders]);

  return (
    <div className="min-h-screen bg-[#F4F1EA]">
      {showRedditModal && redditDefaults && (
        <RedditShareModal
          subreddit={process.env.NEXT_PUBLIC_PRANA_REDDIT_SUBREDDIT || "prana"}
          defaultTitle={redditDefaults.title}
          defaultBody={redditDefaults.body}
          runId={runId || undefined}
          onClose={() => setShowRedditModal(false)}
        />
      )}
      {/* Emergency banner */}
      {rd?.urgency === "emergency" && (
        <div className="bg-[#DC2626] text-white py-4 px-4 sm:px-6 text-center">
          <div className="max-w-2xl mx-auto flex items-center justify-center gap-2 mb-2">
            <AlertCircle className="w-5 h-5" />
            <span className="font-bold uppercase tracking-wide">{T.emergencyHeader}</span>
          </div>
          <p className="text-sm mb-3">{T.emergencyMsg}</p>
          <a
            href="tel:911"
            className="inline-flex items-center justify-center bg-white text-[#DC2626] font-bold rounded-full px-8 min-h-[52px] text-base hover:bg-red-50 transition-colors"
          >
            {T.call911}
          </a>
        </div>
      )}

      <div className="px-4 sm:px-6 py-6 sm:py-8 max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <a href="/" className="text-[#1F3A2E] text-sm font-medium hover:opacity-70 transition-opacity">
            {T.newIntake}
          </a>
          <div className="ml-auto flex items-center gap-2">
            <LanguagePicker />
            <button
              onClick={() => router.push("/profile")}
              className="text-sm text-[#6B7280] border border-[#1F3A2E]/20 rounded-full px-4 py-2 hover:border-[#1F3A2E]/40 transition-colors"
            >
              Profile
            </button>
            <button
              onClick={() => router.push("/graph")}
              className="text-sm text-[#6B7280] border border-[#1F3A2E]/20 rounded-full px-4 py-2 hover:border-[#1F3A2E]/40 transition-colors"
            >
              {T.graph}
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
              {T.analyzingIntake}
            </p>
          </motion.div>
        ) : !run && !runId ? (
          <div>
            <h1 className="font-serif text-[#1F3A2E] text-2xl sm:text-[36px] leading-[1.3] font-medium mb-3">
              {T.intakeHistory}
            </h1>
            <p className="text-[#6B7280] mb-8">
              {T.pickPast}
            </p>

            {pastLoading ? (
              <p className="text-[#6B7280] text-sm">{T.loading}</p>
            ) : pastRuns.length === 0 ? (
              <div className="bg-[#EFEAE0] rounded-2xl p-8 text-center border border-[#1F3A2E]/10">
                <p className="font-serif text-[#1F3A2E] text-xl mb-3">{T.noPast}</p>
                <p className="text-[#6B7280] text-sm mb-6">
                  {T.startIntakeBlurb}
                </p>
                <a
                  href="/"
                  className="inline-block bg-[#1F3A2E] text-white py-3 px-8 rounded-full font-medium hover:bg-[#2A4D3D] transition-colors"
                >
                  {T.startIntakeBtn}
                </a>
              </div>
            ) : (
              <div className="space-y-3">
                {pastRuns.map((r) => {
                  const label = r.rd_summary ?? r.intake_summary ?? r.instruction ?? T.intakeSessionFallback;
                  const date = new Date(r.created_at).toLocaleDateString(undefined, {
                    month: "short", day: "numeric", year: "numeric",
                  });
                  const cfg = r.urgency ? urgencyConfig[r.urgency] : null;
                  const pathLabel = r.recommended_path
                    ? PATH_T[r.recommended_path as keyof typeof PATH_CONFIG]?.label
                      ?? PATH_CONFIG[r.recommended_path as keyof typeof PATH_CONFIG]?.label
                      ?? r.recommended_path.replace(/_/g, " ")
                    : T.pending;
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
                  {T.analyzing}
                </div>
              )}

              <h1 className="font-serif text-[#1F3A2E] text-2xl sm:text-[36px] leading-[1.3] font-medium mt-4 mb-3">
                {tSummary ?? (run?.intake_summary ? T.planReady : T.processingIntake)}
              </h1>

              {/* Citations */}
              {rd?.citations && rd.citations.length > 0 && (() => {
                const grouped = rd.citations.reduce<Record<string, typeof rd.citations>>((acc, c) => {
                  (acc[c.condition] ??= []).push(c);
                  return acc;
                }, {});
                return (
                  <div className="mb-4 space-y-1.5">
                    {Object.entries(grouped).map(([condition, sources]) => (
                      <div key={condition} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="text-[#3D3D3D] text-xs font-medium capitalize">{condition}:</span>
                        {sources.map((c, i) => (
                          <a
                            key={i}
                            href={c.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-[#1F3A2E] underline underline-offset-2 hover:opacity-60 transition-opacity"
                          >
                            {c.source}
                          </a>
                        ))}
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* Suggested next step */}
              {rd?.next_actions && rd.next_actions.length > 0 && (
                <div className="bg-[#EFEAE0] rounded-2xl p-5 border-l-4 border-[#1F3A2E]">
                  <p className="text-[#1F3A2E] font-medium mb-2">{T.nextSteps}</p>
                  <ul className="space-y-1.5">
                    {rd.next_actions.map((action, i) => (
                      <li key={i} className="text-[#3D3D3D] text-sm leading-relaxed">
                        • {tNextActions[i] ?? action}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Patient input pair: what they said + what the AI saw in the
                  video. Shown together so a viewer can compare verbal report
                  with visual context at a glance. "What you shared" used to
                  hide once the routing decision landed; now it stays so it
                  pairs cleanly with the video block below. */}
              {(run?.intake_summary || run?.video_analysis || isVideoPending(run)) && (
                <div className="space-y-3">
                  {run?.intake_summary && (
                    <div className="bg-[#EFEAE0] rounded-2xl p-5 border-l-4 border-[#1F3A2E]">
                      <p className="text-[#1F3A2E] font-medium mb-1">{T.whatYouShared}</p>
                      <p className="text-[#3D3D3D] text-base leading-relaxed">{tIntakeSummary ?? run.intake_summary}</p>
                    </div>
                  )}
                  {(run?.video_analysis || isVideoPending(run)) && (() => {
                    // Extract the predicted temperature line from the
                    // analysis text so we can surface it as a prominent badge
                    // (instead of buried inside the paragraph). Strips the
                    // line from the body so it isn't shown twice.
                    const raw = run?.video_analysis ?? "";
                    const tempMatch = raw.match(/Predicted body temperature:\s*([\d.]+)\s*°?F\s*\(±\s*([\d.]+)\s*°?F\)/i);
                    const predictedF = tempMatch ? parseFloat(tempMatch[1]) : null;
                    const bandF = tempMatch ? parseFloat(tempMatch[2]) : null;
                    const bodyText = tempMatch ? raw.replace(tempMatch[0], "").trim() : raw;
                    // Color the temp chip by deviation from normal (98.6°F).
                    const tempColor =
                      predictedF == null ? "#6B7280" :
                      predictedF >= 100.4 ? "#DC2626" :       // fever
                      predictedF >= 99.5  ? "#EA580C" :       // low-grade
                      predictedF <= 96.5  ? "#1D4ED8" :       // hypothermia
                      "#16A34A";                              // normal-ish
                    return (
                      <div className="bg-[#EFEAE0] rounded-2xl p-5 border-l-4 border-[#1F3A2E]">
                        <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
                          <p className="text-[#1F3A2E] font-medium flex items-center gap-2 m-0">
                            <span aria-hidden>🎥</span>
                            <span>{T.whatVisibleInVideo}</span>
                          </p>
                          {predictedF != null && (
                            <span
                              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold whitespace-nowrap"
                              style={{ background: `${tempColor}20`, color: tempColor }}
                              title="Twelve Labs visual inference — not a medical reading"
                            >
                              🌡️ {predictedF.toFixed(1)}°F {bandF != null && `(±${bandF}°F)`}
                            </span>
                          )}
                        </div>
                        {run?.video_analysis ? (
                          <p className="text-[#3D3D3D] text-base leading-relaxed whitespace-pre-wrap">
                            {bodyText}
                          </p>
                        ) : (
                          <p className="text-[#6B7280] text-sm italic animate-pulse">
                            {T.videoAnalysisPending}
                          </p>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* Disclaimers */}
              {rd?.disclaimers && rd.disclaimers.length > 0 && (
                <p className="text-[#6B7280] text-xs mt-4 italic">
                  {tDisclaimers.join(" ")}
                </p>
              )}

              {/* Share — surfaces the routing summary on Reddit via Composio */}
              {rd && !isDemo && (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => setShowRedditModal(true)}
                    className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
                    style={{ background: "#FF4500", minHeight: 40 }}
                  >
                    {/* Reddit alien glyph */}
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M22 12.14a2.16 2.16 0 0 0-3.66-1.55 10.65 10.65 0 0 0-5.82-1.84l1-4.7 3.27.69a1.54 1.54 0 1 0 .15-.78l-3.65-.78a.39.39 0 0 0-.46.3l-1.13 5.27a10.66 10.66 0 0 0-5.93 1.84A2.16 2.16 0 1 0 4 13.6c-.02.2-.03.4-.03.6 0 3.05 3.59 5.53 8.02 5.53s8.02-2.48 8.02-5.53c0-.2-.01-.4-.03-.6a2.16 2.16 0 0 0 2.02-1.46zM7.6 13.6a1.31 1.31 0 1 1 2.62 0 1.31 1.31 0 0 1-2.62 0zm7.55 3.7c-.92.92-2.7 1-3.16 1s-2.23-.08-3.16-1a.34.34 0 1 1 .49-.49c.59.6 1.86.81 2.67.81s2.07-.21 2.67-.8a.34.34 0 0 1 .49.49zm-.18-2.39a1.31 1.31 0 1 1 0-2.62 1.31 1.31 0 0 1 0 2.62z"/>
                    </svg>
                    Share to Reddit
                  </button>
                  <span className="text-[10px] text-[#6B7280]">
                    Posts as you on Reddit (via Composio). You&apos;ll review before submitting.
                  </span>
                </div>
              )}
            </motion.div>

            {/* MoE expert route — combined voice + video routing decision */}
            {(run?.expert_route || isVideoPending(run)) && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-[#1F3A2E]/5 rounded-2xl p-5 border-l-4 border-[#1F3A2E] mb-6"
              >
                <p className="text-[#6B7280] text-xs uppercase tracking-wider mb-1">
                  Routed to
                </p>
                {run?.expert_route ? (
                  <>
                    <p className="text-[#1F3A2E] font-serif text-xl font-medium">
                      {EXPERT_LABEL[run.expert_route] ?? run.expert_route}
                    </p>
                    {run.expert_rationale && (
                      <p className="text-[#3D3D3D] text-sm mt-2 leading-relaxed">
                        {run.expert_rationale}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-[#6B7280] text-sm italic animate-pulse">
                    Choosing expert…
                  </p>
                )}
              </motion.div>
            )}

            {/* Cost transparency */}
            {rd && rd.urgency !== "wellness" && (
              <CostTransparency urgency={rd.urgency} recommendedPath={rd.recommended_path} />
            )}

            {/* Care path cards */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="mb-24"
            >
              <h2 className="font-serif text-[#1F3A2E] text-2xl font-medium mb-4">
                {T.choosePath}
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                {(["doctor", "pharmacy", "mental_health", "alt_medicine"] as const).map((path) => (
                  <RouteCard
                    key={path}
                    path={path}
                    label={PATH_T[path].label}
                    desc={PATH_T[path].desc}
                    recommendedLabel={T.recommended}
                    recommended={rd?.recommended_path === path}
                    onClick={() => navigate(path)}
                  />
                ))}
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
            <span>{T.newConv}</span>
          </button>
          <button
            onClick={() => router.push("/?history=true")}
            className="flex-1 flex items-center justify-center gap-2 bg-[#1F3A2E] text-white py-3 px-5 rounded-full font-medium text-sm hover:bg-[#2A4D3D] transition-colors min-h-[48px]"
          >
            <Bookmark className="w-4 h-4" />
            <span>{T.viewHistory}</span>
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
