"use client";

import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { motion } from "motion/react";
import LanguagePicker from "@/app/components/LanguagePicker";
import { useTranslate } from "@/lib/translate";
import {
  getRun, runRanker, getRanker, createDoctorCheckout,
  type RankerSelectionItem,
} from "@/lib/api";

interface ProviderResult {
  provider: string;
  specialty?: string | null;
  time?: string | null;
  address?: string | null;
  listingUrl?: string | null;
  acceptsInsurance?: boolean | null;
}

// Mirrors DOCTOR_COSTS in agents/prana/agent.py — fallback visit fee when the
// ranker hasn't picked an item yet so the Book button always quotes the right
// price for the current urgency.
const DOCTOR_VISIT_COST: Record<string, number> = {
  emergency: 350,
  urgent: 175,
  routine: 150,
  wellness: 120,
};

interface SessionInfo {
  agent: string;
  sessionId: string;
  liveUrl: string;
  status: string;
  error?: string;
  done?: boolean;
  output?: string | null;
  mock?: boolean;
}

// Resolve America/Los_Angeles UTC offset on a given LA-local date — returns
// "-07:00" or "-08:00" depending on whether DST is active that day.
const LA_TZ = "America/Los_Angeles";
function laOffsetForDate(year: number, month: number, day: number): string {
  // Pick a moment ~noon LA on that date so we're far from any DST boundary.
  const ref = new Date(Date.UTC(year, month - 1, day, 20, 0, 0));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: LA_TZ,
    timeZoneName: "shortOffset",
  }).formatToParts(ref);
  const tzn = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-8";
  const m = tzn.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return "-08:00";
  return `${m[1]}${m[2].padStart(2, "0")}:${(m[3] ?? "00").padStart(2, "0")}`;
}
function laIso(y: number, mo: number, d: number, h: number, mi: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:00${laOffsetForDate(y, mo, d)}`;
}
function todayInLA(): { y: number; m: number; d: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: LA_TZ,
    weekday: "short", year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
    weekday: wdMap[get("weekday")] ?? 0,
  };
}
const WEEKDAY_RX = /\b(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b/i;
const WEEKDAY_MAP: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
};
/**
 * Parse fuzzy listing-time strings ("Tomorrow 10:00 AM", "Fri 2:30 PM",
 * "Today 3pm") into an ISO timestamp anchored to America/Los_Angeles. Returns
 * `null` for `iso` when the string lacks a time-of-day so callers can fall back
 * to the calendar route's default.
 */
function parseAppointmentTime(raw: string | null | undefined): { iso: string | null; pretty: string } {
  const text = (raw ?? "").trim();
  if (!text) return { iso: null, pretty: "" };
  const timeM = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!timeM) return { iso: null, pretty: text };
  let hour = Number(timeM[1]);
  const minute = Number(timeM[2] ?? "0");
  const ampm = timeM[3].toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;

  const lower = text.toLowerCase();
  const today = todayInLA();
  const addDays = (n: number) => {
    const t = new Date(Date.UTC(today.y, today.m - 1, today.d));
    t.setUTCDate(t.getUTCDate() + n);
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  };

  let target: { y: number; m: number; d: number };
  if (/\btoday\b/.test(lower)) {
    target = { y: today.y, m: today.m, d: today.d };
  } else if (/\btomorrow\b|\btmrw\b/.test(lower)) {
    target = addDays(1);
  } else {
    const wdM = lower.match(WEEKDAY_RX);
    if (wdM) {
      const wd = WEEKDAY_MAP[wdM[1].toLowerCase()] ?? today.weekday;
      let delta = (wd - today.weekday + 7) % 7;
      if (delta === 0) delta = 7; // same weekday → next week
      target = addDays(delta);
    } else {
      target = addDays(1); // best-guess fallback
    }
  }
  return { iso: laIso(target.y, target.m, target.d, hour, minute), pretty: text };
}

function parseProviders(output: string | object | null | undefined): ProviderResult[] {
  if (!output) return [];

  // Accept already-parsed objects, raw strings, and strings that wrap JSON in
  // markdown fences (```json ... ```). Try several common keys BrowserUse
  // schemas may emit.
  let parsed: unknown = output;
  if (typeof output === "string") {
    let text = output.trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fence) text = fence[1];
    try {
      parsed = JSON.parse(text);
    } catch {
      // Sometimes the SDK returns the structured object's stringification
      // wrapped in extra prose; try to extract the first {...} block.
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch { return []; }
      } else {
        return [];
      }
    }
  }

  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed as Record<string, unknown>;

  const candidate =
    obj.appointments ?? obj.providers ?? obj.results ?? obj.items ??
    (typeof obj.data === "object" && obj.data
      ? (obj.data as Record<string, unknown>).appointments ??
        (obj.data as Record<string, unknown>).providers
      : undefined);

  return Array.isArray(candidate) ? (candidate as ProviderResult[]) : [];
}

// ---------------------------------------------------------------------------
// Popup that lists every parsed provider across all 3 search agents.
// Auto-opens once every agent reports `done` (or on demand via the button).
// ---------------------------------------------------------------------------

function ResultsModal({
  sessions,
  onClose,
  onBookNow,
  hasRanker,
}: {
  sessions: SessionInfo[];
  onClose: () => void;
  onBookNow: () => void;
  hasRanker: boolean;
}) {
  const allProviders: { site: string; provider: ProviderResult }[] = [];
  for (const s of sessions) {
    for (const p of parseProviders(s.output)) {
      allProviders.push({ site: s.agent, provider: p });
    }
  }
  const sitesWithResults = new Set(allProviders.map((g) => g.site));
  const completedSites = sessions.filter((s) => s.done).length;

  const tArr = useTranslate([
    "Provider Results",                                     // 0
    "appointment",                                          // 1
    "appointments",                                         // 2
    "from",                                                 // 3
    "of",                                                   // 4
    "sites",                                                // 5
    "agents finished",                                      // 6
    "No providers parsed yet. The search agents may have hit a captcha or empty results — try again, or search directly on Healthgrades or Solv.", // 7
    "Earliest:",                                            // 8
    "Accepts insurance",                                    // 9
    "View →",                                               // 10
    "Close",                                                // 11
    "Book ranker pick",                                     // 12
    "Book first provider",                                  // 13
  ]);
  const m = {
    title: tArr[0], one: tArr[1], many: tArr[2], from: tArr[3], of: tArr[4],
    sites: tArr[5], finished: tArr[6], noProviders: tArr[7], earliest: tArr[8],
    insurance: tArr[9], view: tArr[10], close: tArr[11],
    bookRanker: tArr[12], bookFirst: tArr[13],
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[1000] flex items-center justify-center px-4 py-6"
      style={{ background: "rgba(31,58,46,0.45)" }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="rounded-2xl w-full max-w-2xl overflow-y-auto"
        style={{
          background: "#F4F1EA",
          border: "1px solid rgba(31,58,46,0.15)",
          maxHeight: "85vh",
          padding: "24px 28px",
        }}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="font-serif text-[#1F3A2E] text-2xl font-medium m-0">
              {m.title}
            </h2>
            <div className="text-xs text-[#6B7280] mt-1">
              {allProviders.length} {allProviders.length !== 1 ? m.many : m.one} {m.from} {sitesWithResults.size} {m.of} {sessions.length} {m.sites}
              {completedSites < sessions.length && ` · ${completedSites}/${sessions.length} ${m.finished}`}
            </div>
          </div>
          <button
            onClick={onClose}
            className="bg-transparent border-none cursor-pointer text-[#6B7280] hover:text-[#1F3A2E] flex items-center justify-center"
            style={{ fontSize: 22, padding: "0 6px", minHeight: 36 }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {allProviders.length === 0 ? (
          <div className="bg-[#EFEAE0] border border-[#1F3A2E]/10 rounded-xl px-5 py-8 text-center text-sm text-[#6B7280]">
            {m.noProviders}
          </div>
        ) : (
          <div className="space-y-2.5">
            {allProviders.map(({ site, provider }, i) => (
              <div
                key={i}
                className="bg-[#EFEAE0] border border-[#1F3A2E]/10 rounded-xl px-4 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-sm text-[#1F3A2E] truncate">
                      {provider.provider}
                    </div>
                    {provider.specialty && (
                      <div className="text-xs text-[#6B7280] mt-0.5">{provider.specialty}</div>
                    )}
                    {provider.address && (
                      <div className="text-xs text-[#6B7280] mt-1">📍 {provider.address}</div>
                    )}
                    {provider.time && (
                      <div className="text-xs text-[#16A34A] mt-1">🗓 {m.earliest} {provider.time}</div>
                    )}
                    {provider.acceptsInsurance === true && (
                      <div className="text-[10px] text-[#155E75] mt-1">✓ {m.insurance}</div>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                    <span
                      className="text-[10px] font-semibold uppercase rounded-full px-2 py-0.5 tracking-wider"
                      style={{ background: "rgba(31,58,46,0.10)", color: "#1F3A2E" }}
                    >
                      {site}
                    </span>
                    {provider.listingUrl && (
                      <a
                        href={provider.listingUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs underline text-[#1F3A2E]"
                      >
                        {m.view}
                      </a>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-3 mt-5">
          <button
            onClick={onClose}
            className="flex-1 rounded-full font-medium text-sm cursor-pointer"
            style={{
              background: "rgba(31,58,46,0.08)",
              color: "#1F3A2E",
              border: "none",
              minHeight: 44,
            }}
          >
            {m.close}
          </button>
          {allProviders.length > 0 && (
            <button
              onClick={onBookNow}
              className="flex-1 rounded-full font-medium text-sm cursor-pointer"
              style={{
                background: "#1F3A2E",
                color: "#FFFFFF",
                border: "none",
                minHeight: 44,
              }}
            >
              {hasRanker ? m.bookRanker : m.bookFirst}
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}

const FIXTURE_SESSIONS: SessionInfo[] = [
  { agent: "Healthgrades", sessionId: "mock_healthgrades_fixture", liveUrl: "", status: "completed", done: true, mock: true },
  { agent: "Solv", sessionId: "mock_solv_fixture", liveUrl: "", status: "completed", done: true, mock: true },
];

export default function DoctorPage() {
  const { runId } = useParams<{ runId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const paymentStatus = searchParams.get("payment");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [specialty, setSpecialty] = useState("primary care");
  const [location, setLocation] = useState("Los Angeles, CA");
  const [intakeSummary, setIntakeSummary] = useState("");
  const [urgency, setUrgency] = useState("routine");
  const [rankerItems, setRankerItems] = useState<RankerSelectionItem[]>([]);
  const [rankerRationale, setRankerRationale] = useState("");
  const [rankerLoading, setRankerLoading] = useState(false);
  const [bookingLoading, setBookingLoading] = useState(false);
  const [bookingError, setBookingError] = useState<string | null>(null);
  const [showResults, setShowResults] = useState(false);
  const resultsAutoOpenedRef = useRef(false);
  const rankerFiredRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rankerPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!runId || runId === "no-run") return;
    getRun(runId).then((run) => {
      if (run.intake_summary) setIntakeSummary(run.intake_summary);
      if (run.routing_decision?.urgency) setUrgency(run.routing_decision.urgency);
      // Tailor the specialty + location to this session's intake context.
      const sessionSpecialty = run.routing_decision?.specialty?.trim();
      const sessionLocation = run.routing_decision?.location?.trim();
      if (sessionSpecialty) setSpecialty(sessionSpecialty);
      if (sessionLocation) setLocation(sessionLocation);
    }).catch(() => {});
    getRanker(runId, "doctor").then((data) => {
      if (data.items?.length) setRankerItems(data.items);
    }).catch(() => {});
  }, [runId]);

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

  // Stop active BrowserUse sessions on tab close (NOT on every sessions state update —
  // that was killing live streams the moment polling updated them).
  const sessionsRef = useRef<SessionInfo[]>([]);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  useEffect(() => {
    const stop = () => {
      // Skip mock fixtures — BrowserUse SDK throws on unknown IDs.
      const ids = sessionsRef.current
        .map((s) => s.sessionId)
        .filter((id) => id && !id.startsWith("mock_") && !id.startsWith("mock-"));
      if (!ids.length) return;
      const body = JSON.stringify({ sessionIds: ids });
      if (typeof navigator !== "undefined" && navigator.sendBeacon) {
        navigator.sendBeacon("/api/browser/stop", new Blob([body], { type: "application/json" }));
      } else {
        fetch("/api/browser/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {});
      }
    };
    window.addEventListener("beforeunload", stop);
    return () => {
      window.removeEventListener("beforeunload", stop);
      // Only fire on actual page-unmount (route change), not on every sessions update.
      stop();
    };
  }, []);

  const statusDot = (s: SessionInfo) =>
    s.done ? "#16A34A" : s.status === "error" ? "#DC2626" : "#D97706";

  // Fire ranker once all 3 doctor agents finish parsing
  useEffect(() => {
    if (!runId || runId === "no-run") return;
    if (rankerFiredRef.current || rankerLoading) return;
    if (!sessions.length) return;
    const allDone = sessions.every((s) => s.done || s.status === "error" || !s.sessionId);
    if (!allDone) return;

    const candidates: { source_agent: string; name: string; price: number;
                        url?: string | null; description?: string | null;
                        metadata: Record<string, unknown> }[] = [];
    for (const s of sessions) {
      for (const p of parseProviders(s.output)) {
        candidates.push({
          source_agent: s.agent,
          name: p.provider,
          price: 0,
          url: p.listingUrl ?? undefined,
          description: p.specialty ? `${p.specialty}${p.address ? ` · ${p.address}` : ""}` : p.address ?? undefined,
          metadata: {
            specialty: p.specialty,
            time: p.time,
            address: p.address,
            accepts_insurance: p.acceptsInsurance,
          },
        });
      }
    }
    if (!candidates.length) return;
    rankerFiredRef.current = true;
    setRankerLoading(true);
    runRanker(runId, {
      domain: "doctor",
      query: specialty,
      intake_summary: intakeSummary,
      urgency,
      candidates,
    })
      .catch((e) => console.warn("[ranker] doctor ranker failed:", e))
      .finally(() => {
        const start = Date.now();
        rankerPollRef.current = setInterval(async () => {
          try {
            const data = await getRanker(runId, "doctor");
            if (data.items.length) {
              setRankerItems(data.items);
              const r = data.items.find((i) => i.rationale)?.rationale ?? "";
              if (r && !rankerRationale) setRankerRationale(r);
              if (rankerPollRef.current) clearInterval(rankerPollRef.current);
              setRankerLoading(false);
            }
          } catch { /* ignore */ }
          if (Date.now() - start > 30000 && rankerPollRef.current) {
            clearInterval(rankerPollRef.current);
            setRankerLoading(false);
          }
        }, 1500);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions]);

  useEffect(() => () => { if (rankerPollRef.current) clearInterval(rankerPollRef.current); }, []);

  // Auto-open the results modal the FIRST time every agent reports done.
  // (Doesn't reopen on subsequent state changes — user can re-open via the button.)
  useEffect(() => {
    if (resultsAutoOpenedRef.current) return;
    if (!sessions.length) return;
    const allDone = sessions.every((s) => s.done || s.status === "error" || !s.sessionId);
    if (allDone) {
      resultsAutoOpenedRef.current = true;
      setShowResults(true);
    }
  }, [sessions]);

  const rankerSelected = rankerItems.filter((i) => i.selected);
  const rankerSelectedTotal = rankerSelected.reduce((s, i) => s + i.price, 0);

  // One-shot: when Stripe redirects back with payment=success and we have a
  // booked pick, log it to Google Calendar via Composio. Guarded by a
  // localStorage key so a page reload doesn't double-log.
  const calendarLoggedRef = useRef(false);
  const [calendarLogged, setCalendarLogged] = useState<{ link?: string | null; notConnected?: boolean } | null>(null);
  useEffect(() => {
    if (paymentStatus !== "success") return;
    if (calendarLoggedRef.current) return;
    if (!rankerSelected.length) return;
    const guardKey = `prana.calendar_logged.${runId}`;
    if (typeof window !== "undefined" && localStorage.getItem(guardKey)) return;

    calendarLoggedRef.current = true;
    const top = rankerSelected[0];
    const meta = (top.metadata ?? {}) as Record<string, unknown>;
    const timeStr = typeof meta.time === "string" ? meta.time : undefined;
    const parsedTime = parseAppointmentTime(timeStr);

    fetch("/api/composio/calendar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId,
        provider: top.name,
        specialty: typeof meta.specialty === "string" ? meta.specialty : undefined,
        source: top.source_agent,
        address: typeof meta.address === "string" ? meta.address : undefined,
        time: timeStr,
        startIso: parsedTime.iso ?? undefined,
        listingUrl: top.url ?? undefined,
        amountPaid: rankerSelectedTotal,
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.logged) {
          if (typeof window !== "undefined") localStorage.setItem(guardKey, "1");
          setCalendarLogged({ link: data.htmlLink });
        } else if (data.calendarNotConnected) {
          setCalendarLogged({ notConnected: true });
        }
      })
      .catch(() => { /* non-fatal */ });
  }, [paymentStatus, rankerSelected, rankerSelectedTotal, runId]);

  // Bookable items: prefer the ranker's selection, fall back to the first
  // parsed provider so a Book button is always reachable when at least one
  // session returned a provider (the ranker may not have fired yet, or may
  // have selected nothing).
  const fallbackProvider = (() => {
    for (const s of sessions) {
      const parsed = parseProviders(s.output);
      if (parsed.length) return { site: s.agent, provider: parsed[0] };
    }
    return null;
  })();
  const bookableItems = rankerSelected.length > 0
    ? rankerSelected.map((r) => ({
        id: r.id,
        name: r.name,
        price: r.price,
        source_agent: r.source_agent,
        description: r.description,
      }))
    : fallbackProvider
      ? [{
          id: undefined,
          name: fallbackProvider.provider.provider,
          price: DOCTOR_VISIT_COST[urgency] ?? DOCTOR_VISIT_COST.routine,
          source_agent: fallbackProvider.site,
          description: fallbackProvider.provider.specialty
            ?? fallbackProvider.provider.address
            ?? null,
        }]
      : [];
  const canBook = bookableItems.length > 0;

  const handleBookAppointment = async () => {
    if (!bookableItems.length) return;
    setBookingLoading(true);
    setBookingError(null);
    try {
      const { checkout_url } = await createDoctorCheckout(runId, bookableItems);
      window.location.href = checkout_url;
    } catch (e) {
      setBookingError(e instanceof Error ? e.message : "Booking failed");
      setBookingLoading(false);
    }
  };

  const totalProvidersFound = sessions.reduce((n, s) => n + parseProviders(s.output).length, 0);

  // i18n — translate static UI strings + the dynamic intake summary.
  const STATIC_KEYS = useMemo(() => [
    "← Dashboard",                                                                    // 0
    "Doctor Appointment Search",                                                      // 1
    "For wellness care navigation only. Always verify provider credentials. In emergencies, call 911.", // 2
    "Search for Providers",                                                           // 3
    "Specialty / Concern",                                                            // 4
    "Location",                                                                       // 5
    "Launch Search Agents (×3)",                                                      // 6
    "Launching agents…",                                                              // 7
    "agents complete · Searching for",                                                // 8
    "in",                                                                             // 9
    "Searching…",                                                                     // 10
    "Complete",                                                                       // 11
    "Failed",                                                                         // 12
    "Demo Mode",                                                                      // 13
    "BrowserUse free-tier task quota reached. Showing fixture results so the demo continues.", // 14
    "Waiting for live session…",                                                      // 15
    "Provider results",                                                               // 16
    "Ready to book your appointment",                                                 // 17
    "Redirecting to Stripe…",                                                         // 18
    "Booking cancelled. You can re-attempt the booking below.",                       // 19
    "✓ Appointment Booked",                                                           // 20
    "📅 Added to your Google Calendar",                                                // 21
    "View event →",                                                                   // 22
    "📅 Connect Google Calendar to auto-log future bookings.",                         // 23
    "Connect →",                                                                      // 24
    "🤖 Ranker Agent",                                                                 // 25
    "Ranking providers…",                                                             // 26
    "Appointments found",                                                             // 27
    "Waiting for selection…",                                                         // 28
    "Booking",                                                                        // 29
    "No appointment selected.",                                                       // 30
    "Booking total",                                                                  // 31
    "Earliest:",                                                                      // 32
    "Accepts insurance",                                                              // 33
    "View listing →",                                                                 // 34
    "View →",                                                                         // 35
    "Provider Results",                                                               // 36
    "Close",                                                                          // 37
    "Book ranker pick",                                                               // 38
    "Book first provider",                                                            // 39
    "No providers parsed yet. The search agents may have hit a captcha or empty results — try again, or search directly on Healthgrades or Solv.", // 40
  ], []);
  const t = useTranslate(STATIC_KEYS);
  const T = {
    backDashboard: t[0], pageTitle: t[1], disclaimer: t[2], searchHeader: t[3],
    specialtyLabel: t[4], locationLabel: t[5], launchBtn: t[6], launching: t[7],
    completeFor: t[8], inWord: t[9], searching: t[10], statusComplete: t[11],
    statusFailed: t[12], demoMode: t[13], demoBlurb: t[14], waitingLive: t[15],
    providerResults: t[16], readyBook: t[17], redirecting: t[18], bookingCancelled: t[19],
    booked: t[20], calLogged: t[21], viewEvent: t[22], calConnect: t[23], connectCal: t[24],
    rankerHeader: t[25], rankingProviders: t[26], appointmentsFound: t[27],
    waitingSelection: t[28], booking: t[29], noAppointment: t[30], bookingTotal: t[31],
    earliest: t[32], acceptsInsurance: t[33], viewListing: t[34], viewShort: t[35],
    modalTitle: t[36], close: t[37], bookRanker: t[38], bookFirst: t[39],
    noProviders: t[40],
  };
  const tIntake = useTranslate([intakeSummary])[0];

  return (
    <div className="min-h-screen bg-[#F4F1EA]">
      {showResults && (
        <ResultsModal
          sessions={sessions}
          onClose={() => setShowResults(false)}
          onBookNow={() => { setShowResults(false); handleBookAppointment(); }}
          hasRanker={rankerSelected.length > 0}
        />
      )}
      <div className="px-4 sm:px-6 py-6 sm:py-8 max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-3 mb-6">
          <button
            onClick={() => router.push(`/dashboard?run_id=${runId}`)}
            className="text-[#1F3A2E] text-sm font-medium hover:opacity-70 transition-opacity min-h-[44px] flex items-center"
          >
            {T.backDashboard}
          </button>
          <h1 className="font-serif text-[#1F3A2E] text-xl sm:text-2xl font-medium">
            {T.pageTitle}
          </h1>
          {started && totalProvidersFound > 0 && (
            <button
              onClick={() => setShowResults(true)}
              className="ml-auto rounded-full px-4 py-2 text-sm font-medium cursor-pointer"
              style={{
                background: "#1F3A2E",
                color: "#FFFFFF",
                border: "none",
                minHeight: 40,
              }}
            >
              View all {totalProvidersFound} appointments →
            </button>
          )}
          <div className={started && totalProvidersFound > 0 ? "" : "ml-auto"}>
            <LanguagePicker />
          </div>
        </div>

        {/* Disclaimer */}
        <div className="bg-[#EFEAE0] border border-[#1F3A2E]/10 rounded-2xl px-5 py-3 mb-6 text-sm text-[#6B7280]">
          {T.disclaimer}
        </div>

        {!started ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-[#EFEAE0] rounded-2xl p-6 max-w-md"
          >
            <h2 className="font-serif text-[#1F3A2E] text-xl font-medium mb-6">
              {T.searchHeader}
            </h2>

            <div className="space-y-4 mb-6">
              <div>
                <label className="block text-sm text-[#6B7280] mb-2">{T.specialtyLabel}</label>
                <input
                  value={specialty}
                  onChange={(e) => setSpecialty(e.target.value)}
                  className="w-full bg-[#F4F1EA] border border-[#1F3A2E]/20 rounded-xl px-4 py-3 text-[#3D3D3D] focus:outline-none focus:border-[#1F3A2E]/50"
                  style={{ fontSize: 16 }}
                />
              </div>
              <div>
                <label className="block text-sm text-[#6B7280] mb-2">{T.locationLabel}</label>
                <input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  className="w-full bg-[#F4F1EA] border border-[#1F3A2E]/20 rounded-xl px-4 py-3 text-[#3D3D3D] focus:outline-none focus:border-[#1F3A2E]/50"
                  style={{ fontSize: 16 }}
                />
              </div>
            </div>

            <motion.button
              onClick={startSearch}
              disabled={loading}
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.99 }}
              className="w-full bg-[#1F3A2E] text-white rounded-full font-medium text-sm hover:bg-[#2A4D3D] transition-colors disabled:opacity-40 min-h-[52px]"
            >
              {loading ? T.launching : T.launchBtn}
            </motion.button>
          </motion.div>
        ) : (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <p className="text-[#6B7280] text-sm mb-4">
              {sessions.filter((s) => s.done).length}/{sessions.length} {T.completeFor}{" "}
              <strong className="text-[#3D3D3D]">{specialty}</strong> {T.inWord}{" "}
              <strong className="text-[#3D3D3D]">{location}</strong>
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-4xl mx-auto">
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
                    <span className="ml-auto text-xs text-[#6B7280]">
                      {s.done ? T.statusComplete : s.status === "error" ? T.statusFailed : T.searching}
                    </span>
                  </div>
                  {s.mock ? (
                    <div className="aspect-[16/10] flex flex-col items-center justify-center text-center px-4 bg-[#F4F1EA]">
                      <span className="text-[10px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-full bg-[#FEF3C7] text-[#D97706] mb-3">
                        {T.demoMode}
                      </span>
                      <p className="text-[#1F3A2E] text-sm font-medium mb-1">{s.agent}</p>
                      <p className="text-[#6B7280] text-xs leading-relaxed max-w-[220px]">
                        {T.demoBlurb}
                      </p>
                    </div>
                  ) : s.liveUrl ? (
                    <iframe
                      src={s.liveUrl}
                      className="w-full border-none aspect-[16/10] block"
                      title={`${s.agent} browser session`}
                    />
                  ) : (
                    <div className="aspect-[16/10] flex items-center justify-center text-[#6B7280] text-sm">
                      {s.error ? `Error: ${s.error}` : T.waitingLive}
                    </div>
                  )}
                  {s.done && parseProviders(s.output).length > 0 && (
                    <div className="px-4 py-2 border-t border-[#1F3A2E]/10 text-xs text-[#6B7280]">
                      {parseProviders(s.output).length} provider{parseProviders(s.output).length !== 1 ? "s" : ""} found
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* All providers found across agents — visible as soon as ANY output lands */}
            {(() => {
              const groups = sessions
                .map((s) => ({ site: s.agent, providers: parseProviders(s.output) }))
                .filter((g) => g.providers.length > 0);
              if (groups.length === 0) return null;
              const totalFound = groups.reduce((n, g) => n + g.providers.length, 0);
              return (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-[#EFEAE0] rounded-2xl p-6 border border-[#1F3A2E]/15 mt-6"
                >
                  <div className="flex items-center mb-4">
                    <h3 className="font-serif text-[#1F3A2E] text-xl font-medium">
                      Provider results
                    </h3>
                    <span className="ml-auto text-xs text-[#6B7280]">
                      {totalFound} appointment{totalFound !== 1 ? "s" : ""} found across {groups.length} site{groups.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    {groups.map(({ site, providers }) => (
                      <div
                        key={site}
                        className="bg-white border border-[#1F3A2E]/10 rounded-xl p-3"
                      >
                        <div className="text-xs font-semibold text-[#1F3A2E] uppercase tracking-wider mb-2">
                          {site} · {providers.length}
                        </div>
                        <div className="space-y-2">
                          {providers.map((p, i) => (
                            <div
                              key={`${site}-${i}`}
                              className="text-xs text-[#3D3D3D] border-t border-[#1F3A2E]/10 pt-2 first:border-t-0 first:pt-0"
                            >
                              <div className="font-medium text-sm text-[#1F3A2E]">{p.provider}</div>
                              {p.specialty && (
                                <div className="text-[#6B7280] mt-0.5">{p.specialty}</div>
                              )}
                              {p.address && (
                                <div className="text-[#6B7280] mt-0.5">📍 {p.address}</div>
                              )}
                              {p.time && (
                                <div className="text-[#16A34A] mt-0.5">🗓 {p.time}</div>
                              )}
                              {p.acceptsInsurance === true && (
                                <div className="text-[#155E75] mt-0.5">✓ Accepts insurance</div>
                              )}
                              {p.listingUrl && (
                                <a
                                  href={p.listingUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-block text-[#1F3A2E] underline mt-1"
                                >
                                  View listing →
                                </a>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </motion.div>
              );
            })()}

            {/* Always-visible Book CTA: shows once any provider is parsed,
                regardless of ranker state. Falls back to the first provider
                if the ranker hasn't selected anything yet. */}
            {canBook && paymentStatus !== "success" && (() => {
              // Pull the listing time off the top ranker pick (or the fallback
              // provider) so the user sees the slot they're paying for.
              const topMeta = (rankerSelected[0]?.metadata ?? {}) as Record<string, unknown>;
              const ctaTimeStr = (typeof topMeta.time === "string" && topMeta.time.trim())
                || fallbackProvider?.provider.time
                || "";
              return (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-[#1F3A2E] text-white rounded-2xl p-6 mt-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4"
              >
                <div>
                  <div className="font-serif text-xl font-medium">
                    {rankerSelected.length > 0
                      ? `Ready to book ${rankerSelected.length} appointment${rankerSelected.length !== 1 ? "s" : ""}`
                      : "Ready to book your appointment"}
                  </div>
                  <div className="text-sm text-white/75 mt-1">
                    {bookableItems[0]?.source_agent} · {bookableItems[0]?.name}
                    {bookableItems.length > 1 ? ` (+${bookableItems.length - 1} more)` : ""}
                  </div>
                  {ctaTimeStr && (
                    <div className="text-sm text-white mt-2 inline-flex items-center gap-1.5 bg-white/10 rounded-full px-3 py-1">
                      <span>📅</span>
                      <span>{ctaTimeStr}</span>
                      <span className="text-white/60">· PT</span>
                    </div>
                  )}
                  {bookingError && (
                    <div className="text-[#FCA5A5] text-sm mt-2">{bookingError}</div>
                  )}
                </div>
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handleBookAppointment}
                  disabled={bookingLoading}
                  className="bg-white text-[#1F3A2E] font-medium rounded-full px-6 py-3 min-h-[44px] disabled:opacity-50 hover:bg-white/90 transition-colors"
                >
                  {bookingLoading
                    ? "Redirecting to Stripe…"
                    : `Book & Pay $${bookableItems.reduce((s, i) => s + (i.price ?? 0), 0).toFixed(2)}`}
                </motion.button>
              </motion.div>
              );
            })()}

            {/* Payment success / cancel banners */}
            {paymentStatus === "success" && rankerSelected.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-[#DCFCE7] border border-[#16A34A]/30 rounded-2xl px-5 py-4 mt-6"
              >
                <div className="text-[#16A34A] font-semibold mb-2">✓ Appointment Booked</div>
                <div className="space-y-1.5">
                  {rankerSelected.map((it) => (
                    <div key={it.id ?? it.name} className="flex justify-between text-sm text-[#3D3D3D]">
                      <span><strong>{it.source_agent}</strong> · {it.name}</span>
                      <span className="text-[#16A34A] font-semibold">${it.price.toFixed(2)}</span>
                    </div>
                  ))}
                </div>

                {/* Composio Google Calendar logger status */}
                {calendarLogged?.link && (
                  <div className="mt-3 pt-3 border-t border-[#16A34A]/20 text-xs text-[#16A34A] flex items-center gap-2">
                    <span>📅 Added to your Google Calendar</span>
                    <a
                      href={calendarLogged.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:opacity-70"
                    >
                      View event →
                    </a>
                  </div>
                )}
                {calendarLogged?.notConnected && (
                  <div className="mt-3 pt-3 border-t border-[#16A34A]/20 text-xs text-[#6B7280] flex items-center gap-2">
                    <span>📅 Connect Google Calendar to auto-log future bookings.</span>
                    <a
                      href="/api/composio/connect?toolkit=googlecalendar"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline text-[#1F3A2E] hover:opacity-70"
                    >
                      Connect →
                    </a>
                  </div>
                )}
              </motion.div>
            )}
            {paymentStatus === "cancel" && (
              <div className="bg-[#FEE2E2] border border-[#DC2626]/20 rounded-2xl px-5 py-3 mt-6 text-sm text-[#DC2626]">
                Booking cancelled. You can re-attempt the booking below.
              </div>
            )}

            {/* Ranker sidebar — Found vs Booked */}
            {(rankerLoading || rankerItems.length > 0) && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-[#EFEAE0] rounded-2xl p-6 border border-[#1F3A2E]/15 mt-6"
              >
                <div className="flex items-center mb-4">
                  <h3 className="font-serif text-[#1F3A2E] text-xl font-medium">
                    🤖 Ranker Agent
                  </h3>
                  <span className="ml-auto text-xs text-[#6B7280]">
                    {rankerLoading
                      ? "Ranking providers…"
                      : `${rankerSelected.length} of ${rankerItems.length} picked`}
                  </span>
                </div>
                {rankerRationale && (
                  <p className="text-sm text-[#3D3D3D] bg-white border border-[#1F3A2E]/10 rounded-xl px-4 py-3 mb-4">
                    {rankerRationale}
                  </p>
                )}
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <div className="text-xs font-semibold text-[#1F3A2E] uppercase tracking-wider mb-2">
                      Appointments found ({rankerItems.length})
                    </div>
                    <div className="space-y-1.5 max-h-[280px] overflow-y-auto pr-1">
                      {rankerItems.length === 0 && (
                        <div className="text-xs text-[#6B7280]">Waiting for selection…</div>
                      )}
                      {rankerItems.map((it) => {
                        const meta = it.metadata || {};
                        return (
                          <div
                            key={`${it.source_agent}-${it.name}-${it.id ?? ""}`}
                            className={`text-xs px-3 py-2 rounded-lg border ${
                              it.selected
                                ? "bg-[#DCFCE7] border-[#16A34A]/30 text-[#1F3A2E]"
                                : "bg-white border-[#1F3A2E]/10 text-[#6B7280]"
                            }`}
                          >
                            <div className="flex justify-between gap-2">
                              <span className="truncate">
                                <strong>{it.source_agent}</strong> · {it.name}
                              </span>
                              <span className="font-semibold flex-shrink-0">
                                ${it.price.toFixed(2)}
                              </span>
                            </div>
                            {(meta.time as string) && (
                              <div className="text-[10px] text-[#6B7280] mt-0.5">
                                {meta.time as string}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-[#16A34A] uppercase tracking-wider mb-2">
                      Booking ({rankerSelected.length})
                    </div>
                    <div className="space-y-1.5">
                      {rankerSelected.length === 0 && !rankerLoading && (
                        <div className="text-xs text-[#6B7280]">No appointment selected.</div>
                      )}
                      {rankerSelected.map((it) => (
                        <div
                          key={`sel-${it.id ?? it.name}`}
                          className="bg-white border border-[#16A34A]/30 rounded-lg px-3 py-2"
                        >
                          <div className="flex justify-between gap-2 text-sm">
                            <span className="text-[#1F3A2E] truncate">
                              <strong>{it.source_agent}</strong> · {it.name}
                            </span>
                            <span className="font-semibold text-[#16A34A] flex-shrink-0">
                              ${it.price.toFixed(2)}
                            </span>
                          </div>
                          {it.rationale && (
                            <div className="text-xs text-[#6B7280] mt-1">{it.rationale}</div>
                          )}
                          {(it.metadata?.time as string) && (
                            <div className="text-xs text-[#6B7280] mt-1">
                              🗓 {it.metadata?.time as string}
                            </div>
                          )}
                        </div>
                      ))}
                      {rankerSelected.length > 0 && (
                        <>
                          <div className="flex justify-between pt-2 mt-1 border-t border-[#16A34A]/30 text-sm font-semibold">
                            <span className="text-[#3D3D3D]">Booking total</span>
                            <span className="text-[#16A34A]">${rankerSelectedTotal.toFixed(2)}</span>
                          </div>
                          {bookingError && (
                            <div className="text-[#DC2626] text-sm mt-2">{bookingError}</div>
                          )}
                          <motion.button
                            whileHover={{ scale: 1.01 }}
                            whileTap={{ scale: 0.99 }}
                            onClick={handleBookAppointment}
                            disabled={bookingLoading}
                            className="w-full bg-[#1F3A2E] text-white rounded-full font-medium text-sm hover:bg-[#2A4D3D] transition-colors disabled:opacity-40 min-h-[44px] mt-3"
                          >
                            {bookingLoading
                              ? "Redirecting to Stripe…"
                              : `Book & Pay $${rankerSelectedTotal.toFixed(2)}`}
                          </motion.button>
                          <p className="text-center text-[10px] text-[#6B7280] mt-2">
                            Test card: 4242 4242 4242 4242
                          </p>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </motion.div>
        )}
      </div>
    </div>
  );
}
