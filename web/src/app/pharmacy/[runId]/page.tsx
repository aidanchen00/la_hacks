"use client";

import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { useParams, useSearchParams } from "next/navigation";
import {
  getRun, getBudget, createBudgetCheckout, runRanker, getRanker,
  type CartItem, type RankerSelectionItem,
} from "@/lib/api";
import { motion } from "motion/react";
import LanguagePicker from "@/app/components/LanguagePicker";
import { useTranslate } from "@/lib/translate";

interface SessionInfo {
  agent: string;
  sessionId: string;
  liveUrl: string;
  status: string;
  error?: string;
  done?: boolean;
  mock?: boolean;
}

export default function PharmacyPage() {
  const { runId } = useParams<{ runId: string }>();
  const searchParams = useSearchParams();
  const paymentStatus = searchParams.get("payment");

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("cold and flu relief");
  const [totalBudget, setTotalBudget] = useState(100);
  const [requiresDoctorApproval, setRequiresDoctorApproval] = useState(false);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [intakeSummary, setIntakeSummary] = useState("");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [rankerItems, setRankerItems] = useState<RankerSelectionItem[]>([]);
  const [rankerRationale, setRankerRationale] = useState("");
  const [rankerLoading, setRankerLoading] = useState(false);
  const rankerFiredRef = useRef(false);

  const browserPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cartPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rankerPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!runId || runId === "no-run") return;
    getRun(runId).then((run) => {
      if (run.routing_decision?.requires_doctor_approval) {
        setRequiresDoctorApproval(true);
      }
      if (run.intake_summary) setIntakeSummary(run.intake_summary);
      // Tailor the search query to this session's intake context.
      const sessionQuery = run.routing_decision?.search_query?.trim();
      if (sessionQuery) setQuery(sessionQuery);
    }).catch(() => {});
    // Pick up any prior ranker selection (e.g. on page reload after payment)
    getRanker(runId, "pharmacy").then((data) => {
      if (data.items?.length) {
        setRankerItems(data.items);
      }
    }).catch(() => {});
  }, [runId]);

  const refreshCart = useCallback(async () => {
    if (!runId || runId === "no-run") return;
    try {
      const data = await getBudget(runId);
      setCart(data.cart ?? []);
    } catch { /* no budget session yet */ }
  }, [runId]);

  useEffect(() => {
    refreshCart();
    cartPollRef.current = setInterval(refreshCart, 4000);
    return () => { if (cartPollRef.current) clearInterval(cartPollRef.current); };
  }, [refreshCart]);

  const startSearch = async () => {
    setLoading(true);
    setSearchError(null);
    try {
      const res = await fetch("/api/browser/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "pharmacy", query }),
      });
      const data = await res.json();
      const next: SessionInfo[] = data.sessions ?? [];
      setSessions(next);
      setStarted(true);
      if (next.length === 0) {
        setSearchError("No sessions could be started. The BrowserUse quota may be exhausted — retry in a moment.");
      }
    } catch (e) {
      setStarted(true);
      setSearchError(e instanceof Error ? e.message : "Failed to launch search agents");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!started || !sessions.length) return;
    const active = sessions.filter((s) => s.sessionId && !s.done && s.status !== "error");
    if (!active.length) return;
    browserPollRef.current = setInterval(async () => {
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
    return () => { if (browserPollRef.current) clearInterval(browserPollRef.current); };
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

  const inStockItems = cart.filter((c) => c.in_stock && c.item_name && c.item_price > 0);
  const cartTotal = inStockItems.reduce((sum, c) => sum + c.item_price, 0);

  // Once all sessions are done and the cart has at least one in-stock item,
  // fire the ranker uAgent (only once per run).
  useEffect(() => {
    if (!runId || runId === "no-run") return;
    if (rankerFiredRef.current || rankerLoading) return;
    if (!sessions.length) return;
    const allDone = sessions.every((s) => s.done || s.status === "error" || !s.sessionId);
    if (!allDone) return;
    const candidates = inStockItems.map((c) => ({
      source_agent: c.agent_name || c.platform,
      name: c.item_name || "Unknown",
      price: c.item_price,
      url: c.item_url,
      description: c.item_description,
      metadata: { in_stock: !!c.in_stock, cart_id: c.id, platform: c.platform },
    }));
    if (!candidates.length) return;
    rankerFiredRef.current = true;
    setRankerLoading(true);
    runRanker(runId, {
      domain: "pharmacy",
      query,
      intake_summary: intakeSummary,
      requires_doctor_approval: requiresDoctorApproval,
      total_budget_usd: totalBudget,
      per_agent_budget_usd: totalBudget / 3,
      candidates,
    })
      .catch((e) => console.warn("[ranker] pharmacy ranker failed:", e))
      .finally(() => {
        // Poll for persisted result a few times in case ranker is async
        const start = Date.now();
        rankerPollRef.current = setInterval(async () => {
          try {
            const data = await getRanker(runId, "pharmacy");
            if (data.items.length) {
              setRankerItems(data.items);
              const lastEvtRationale = data.items.find((i) => i.rationale)?.rationale ?? "";
              if (lastEvtRationale && !rankerRationale) setRankerRationale(lastEvtRationale);
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
  }, [sessions, cart.length]);

  // Cleanup ranker poll on unmount
  useEffect(() => () => { if (rankerPollRef.current) clearInterval(rankerPollRef.current); }, []);

  const rankerSelected = rankerItems.filter((i) => i.selected);
  const rankerSelectedTotal = rankerSelected.reduce((s, i) => s + i.price, 0);
  const useRankerCheckout = rankerSelected.length > 0;
  const checkoutItemCount = useRankerCheckout ? rankerSelected.length : inStockItems.length;
  const checkoutTotal = useRankerCheckout ? rankerSelectedTotal : cartTotal;
  const checkoutDisabled = checkoutItemCount === 0 || checkoutLoading;

  // i18n
  const STATIC_KEYS = useMemo(() => [
    "← Dashboard",                                                                  // 0
    "Pharmacy & Wellness Products",                                                 // 1
    "✓ Payment Confirmed — Order Verified",                                         // 2
    "You paid for these",                                                           // 3
    "items, picked by the agents:",                                                 // 4
    "Total Paid",                                                                   // 5
    "Payment cancelled. Your cart is still here — you can review and try again.",   // 6
    "For educational purposes only. Consult a licensed pharmacist or doctor before purchasing any medication.", // 7
    "Search Wellness Products",                                                     // 8
    "What are you looking for?",                                                    // 9
    "Budget Allocation",                                                            // 10
    "Total budget",                                                                 // 11
    "Launching agents…",                                                            // 12
    "Searching for",                                                                // 13
    "across pharmacies",                                                            // 14
    "Searching…",                                                                   // 15
    "Complete",                                                                     // 16
    "Failed",                                                                       // 17
    "Demo Mode",                                                                    // 18
    "BrowserUse free-tier task quota reached. Showing fixture results so the demo continues.", // 19
    "Waiting for live session…",                                                    // 20
    "🤖 Ranker Agent",                                                               // 21
    "Ranking candidates…",                                                          // 22
    "Found",                                                                        // 23
    "Waiting for selection…",                                                       // 24
    "Selected for checkout",                                                        // 25
    "No items selected.",                                                           // 26
    "Selected total",                                                               // 27
    "Your Cart",                                                                    // 28
    "of",                                                                           // 29
    "agent picks in stock",                                                         // 30
    "No matching product found",                                                    // 31
    "Out of stock — excluded from checkout",                                        // 32
    "Total",                                                                        // 33
    "items",                                                                        // 34
    "Redirecting to Stripe…",                                                       // 35
    "No items available to check out",                                              // 36
    "Checkout Ranker picks",                                                        // 37
    "Review & Checkout",                                                            // 38
    "item",                                                                         // 39
    "Test card: 4242 4242 4242 4242 · any future date · any CVC",                   // 40
    "Cart is empty. Items will appear here as the agents finish their searches.",   // 41
    "picked by the agents",                                                         // 42
    "Retry",                                                                        // 43
  ], []);
  const t = useTranslate(STATIC_KEYS);
  const T = {
    back: t[0], pageTitle: t[1], paymentConfirmed: t[2], paidFor: t[3], pickedBy: t[4],
    totalPaid: t[5], cancelled: t[6], disclaimer: t[7], searchHeader: t[8],
    searchPlaceholder: t[9], budgetHeader: t[10], totalBudget: t[11], launching: t[12],
    searchingFor: t[13], acrossPharmacies: t[14], searching: t[15], statusComplete: t[16],
    statusFailed: t[17], demoMode: t[18], demoBlurb: t[19], waitingLive: t[20],
    rankerHeader: t[21], rankingCands: t[22], found: t[23], waitingSel: t[24],
    selectedCheckout: t[25], noSelected: t[26], selectedTotal: t[27], yourCart: t[28],
    ofWord: t[29], inStock: t[30], noProduct: t[31], oos: t[32], totalLabel: t[33],
    itemsWord: t[34], redirecting: t[35], noToCheckout: t[36], checkoutRanker: t[37],
    reviewCheckout: t[38], itemSingular: t[39], testCard: t[40], cartEmpty: t[41],
    pickedByAgents: t[42], retry: t[43],
  };

  const handleCheckout = async () => {
    setCheckoutLoading(true);
    setCheckoutError(null);
    try {
      const items = useRankerCheckout
        ? rankerSelected.map((r) => ({
            id: r.id,
            name: r.name,
            platform: r.source_agent,
            price: r.price,
          }))
        : inStockItems.map((c) => ({
            name: c.item_name ?? "Unknown product",
            platform: c.platform,
            price: c.item_price,
          }));
      const { checkout_url } = await createBudgetCheckout(runId, items);
      window.location.href = checkout_url;
    } catch (e) {
      setCheckoutError(e instanceof Error ? e.message : "Checkout failed");
      setCheckoutLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F4F1EA]">
      <div className="px-4 sm:px-6 py-6 sm:py-8 max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-3 mb-6">
          <a
            href={`/dashboard?run_id=${runId}`}
            className="text-[#1F3A2E] text-sm font-medium hover:opacity-70 transition-opacity min-h-[44px] flex items-center"
          >
            {T.back}
          </a>
          <h1 className="font-serif text-[#1F3A2E] text-xl sm:text-2xl font-medium">
            {T.pageTitle}
          </h1>
          <div className="ml-auto"><LanguagePicker /></div>
        </div>

        {/* Payment success banner — shows what was actually charged
            (ranker subset if the user checked out via the ranker, else cart). */}
        {paymentStatus === "success" && (useRankerCheckout ? rankerSelected.length > 0 : inStockItems.length > 0) && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-[#DCFCE7] border border-[#16A34A]/30 rounded-2xl px-5 py-4 mb-5"
          >
            <div className="text-[#16A34A] font-semibold mb-2">{T.paymentConfirmed}</div>
            <p className="text-[#6B7280] text-sm mb-3">
              {T.paidFor} {useRankerCheckout ? rankerSelected.length : inStockItems.length} {T.pickedBy}
            </p>
            <div className="space-y-1.5">
              {useRankerCheckout
                ? rankerSelected.map((r) => (
                    <div key={`paid-${r.id ?? r.name}`} className="flex justify-between text-sm text-[#3D3D3D]">
                      <span><strong>{r.source_agent}</strong> · {r.name}</span>
                      <span className="text-[#16A34A] font-semibold">${r.price.toFixed(2)}</span>
                    </div>
                  ))
                : inStockItems.map((c) => (
                    <div key={c.id} className="flex justify-between text-sm text-[#3D3D3D]">
                      <span><strong>{c.platform}</strong> · {c.item_name}</span>
                      <span className="text-[#16A34A] font-semibold">${c.item_price.toFixed(2)}</span>
                    </div>
                  ))}
              <div className="flex justify-between pt-2 mt-1 border-t border-[#16A34A]/20 font-semibold">
                <span className="text-[#3D3D3D]">{T.totalPaid}</span>
                <span className="text-[#16A34A]">${(useRankerCheckout ? rankerSelectedTotal : cartTotal).toFixed(2)}</span>
              </div>
            </div>
          </motion.div>
        )}

        {paymentStatus === "cancel" && (
          <div className="bg-[#FEE2E2] border border-[#DC2626]/20 rounded-2xl px-5 py-3 mb-5 text-sm text-[#DC2626]">
            {T.cancelled}
          </div>
        )}

        {/* Disclaimer */}
        <div className="bg-[#EFEAE0] border border-[#1F3A2E]/10 rounded-2xl px-5 py-3 mb-4 text-sm text-[#6B7280]">
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

            <div className="mb-5">
              <label className="block text-sm text-[#6B7280] mb-2">{T.searchPlaceholder}</label>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full bg-[#F4F1EA] border border-[#1F3A2E]/20 rounded-xl px-4 py-3 text-[#3D3D3D] focus:outline-none focus:border-[#1F3A2E]/50"
                style={{ fontSize: 16 }}
              />
            </div>

            <div className="mb-6 bg-[#F4F1EA] border border-[#1F3A2E]/10 rounded-xl p-4">
              <div className="text-xs font-semibold text-[#1F3A2E] uppercase tracking-wider mb-3">
                {T.budgetHeader}
              </div>
              <div className="flex items-center gap-3 mb-3">
                <label className="text-sm text-[#6B7280] flex-shrink-0" style={{ minWidth: 80 }}>{T.totalBudget}</label>
                <input
                  type="number"
                  min={20}
                  max={500}
                  step={10}
                  value={totalBudget}
                  onChange={(e) => setTotalBudget(Number(e.target.value))}
                  className="bg-white border border-[#1F3A2E]/20 rounded-lg px-3 py-1.5 text-[#3D3D3D] text-sm focus:outline-none"
                  style={{ width: 80, textAlign: "right" }}
                />
                <span className="text-[#6B7280] text-sm">USD</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {["CVS", "Walgreens", "GoodRx"].map((site) => (
                  <div key={site} className="bg-white rounded-lg px-2.5 py-2 text-center">
                    <div className="text-xs font-semibold text-[#3D3D3D]">{site}</div>
                    <div className="text-xs text-[#1F3A2E] mt-0.5">${(totalBudget / 3).toFixed(2)}</div>
                  </div>
                ))}
              </div>
            </div>

            <motion.button
              onClick={startSearch}
              disabled={loading}
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.99 }}
              className="w-full bg-[#1F3A2E] text-white rounded-full font-medium text-sm hover:bg-[#2A4D3D] transition-colors disabled:opacity-40 disabled:cursor-not-allowed min-h-[52px]"
            >
              {loading
                ? T.launching
                : `Search CVS · Walgreens · GoodRx ($${totalBudget})`}
            </motion.button>
          </motion.div>
        ) : (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <p className="text-[#6B7280] text-sm mb-4">
              {T.searchingFor} <strong className="text-[#3D3D3D]">{query}</strong> {T.acrossPharmacies}
            </p>
            {searchError && (
              <div className="bg-[#FEE2E2] border border-[#DC2626]/20 rounded-2xl px-5 py-3 mb-4 text-sm text-[#DC2626] flex items-center gap-3">
                <span className="flex-1">{searchError}</span>
                <button
                  onClick={() => { setStarted(false); setSearchError(null); setSessions([]); }}
                  className="rounded-full px-3 py-1.5 text-xs font-medium cursor-pointer bg-[#DC2626] text-white border-none"
                >
                  {T.retry}
                </button>
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 mb-7">
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
                    <span className="ml-auto text-xs text-[#6B7280]">
                      {s.done ? T.statusComplete : s.status === "error" ? T.statusFailed : T.searching}
                    </span>
                  </div>
                  {s.mock ? (
                    <div className="h-[340px] flex flex-col items-center justify-center text-center px-4 bg-[#F4F1EA]">
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
                      className="w-full border-none"
                      style={{ height: 340 }}
                      title={`${s.agent} browser`}
                    />
                  ) : (
                    <div className="h-[340px] flex items-center justify-center text-[#6B7280] text-sm">
                      {s.error ? `Error: ${s.error}` : T.waitingLive}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </motion.div>
        )}

        {/* Ranker sidebar — shows what the Ranker agent picked vs everything found */}
        {(rankerLoading || rankerItems.length > 0) && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-[#EFEAE0] rounded-2xl p-6 border border-[#1F3A2E]/15 mb-5"
          >
            <div className="flex items-center mb-4">
              <h3 className="font-serif text-[#1F3A2E] text-xl font-medium">
                {T.rankerHeader}
              </h3>
              <span className="ml-auto text-xs text-[#6B7280]">
                {rankerLoading
                  ? T.rankingCands
                  : `${rankerSelected.length} ${T.ofWord} ${rankerItems.length}`}
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
                  {T.found} ({rankerItems.length})
                </div>
                <div className="space-y-1.5 max-h-[260px] overflow-y-auto pr-1">
                  {rankerItems.length === 0 && (
                    <div className="text-xs text-[#6B7280]">{T.waitingSel}</div>
                  )}
                  {rankerItems.map((it) => (
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
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-xs font-semibold text-[#16A34A] uppercase tracking-wider mb-2">
                  {T.selectedCheckout} ({rankerSelected.length})
                </div>
                <div className="space-y-1.5">
                  {rankerSelected.length === 0 && !rankerLoading && (
                    <div className="text-xs text-[#6B7280]">{T.noSelected}</div>
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
                    </div>
                  ))}
                  {rankerSelected.length > 0 && (
                    <div className="flex justify-between pt-2 mt-1 border-t border-[#16A34A]/30 text-sm font-semibold">
                      <span className="text-[#3D3D3D]">{T.selectedTotal}</span>
                      <span className="text-[#16A34A]">${rankerSelectedTotal.toFixed(2)}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {/* Cart */}
        {cart.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-[#EFEAE0] rounded-2xl p-6 border border-[#1F3A2E]/15"
          >
            <div className="flex items-center mb-5">
              <h3 className="font-serif text-[#1F3A2E] text-xl font-medium">{T.yourCart}</h3>
              <span className="ml-auto text-xs text-[#6B7280]">
                {inStockItems.length} {T.ofWord} {cart.length} {T.inStock}
              </span>
            </div>

            <div className="space-y-2.5 mb-5">
              {cart.map((c) => {
                const oos = !c.in_stock || !c.item_name || c.item_price <= 0;
                return (
                  <div
                    key={c.id}
                    className={`grid items-center gap-3 px-4 py-3 rounded-xl border ${
                      oos
                        ? "bg-[#F4F1EA] border-[#1F3A2E]/10 opacity-60"
                        : "bg-white border-[#1F3A2E]/15"
                    }`}
                    style={{ gridTemplateColumns: "100px 1fr auto" }}
                  >
                    <div className="text-xs font-semibold text-[#1F3A2E] uppercase tracking-wider">
                      {c.platform}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm text-[#3D3D3D] truncate">
                        {c.item_name ?? T.noProduct}
                      </div>
                      {c.item_description && (
                        <div className="text-xs text-[#6B7280] truncate mt-0.5">
                          {c.item_description}
                        </div>
                      )}
                      {oos && (
                        <div className="text-xs text-[#DC2626] mt-0.5">
                          {T.oos}
                        </div>
                      )}
                    </div>
                    <div
                      className={`text-base font-semibold text-right ${
                        oos ? "text-[#6B7280]" : "text-[#1F3A2E]"
                      }`}
                    >
                      ${c.item_price.toFixed(2)}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex items-center justify-between py-3 border-t border-[#1F3A2E]/15">
              <span className="text-sm text-[#6B7280]">{T.totalLabel} ({inStockItems.length} {T.itemsWord})</span>
              <span className="font-serif text-2xl font-medium text-[#1F3A2E]">${cartTotal.toFixed(2)}</span>
            </div>

            {checkoutError && (
              <div className="text-[#DC2626] text-sm mt-2 mb-2">{checkoutError}</div>
            )}

            <motion.button
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.99 }}
              onClick={handleCheckout}
              disabled={checkoutDisabled}
              className="w-full bg-[#1F3A2E] text-white rounded-full font-medium text-sm hover:bg-[#2A4D3D] transition-colors disabled:opacity-40 disabled:cursor-not-allowed min-h-[52px] mt-3"
            >
              {checkoutLoading
                ? T.redirecting
                : checkoutItemCount === 0
                  ? T.noToCheckout
                  : useRankerCheckout
                    ? `${T.checkoutRanker} (${checkoutItemCount} ${checkoutItemCount > 1 ? T.itemsWord : T.itemSingular} · $${checkoutTotal.toFixed(2)})`
                    : `${T.reviewCheckout} (${checkoutItemCount} ${T.itemsWord} · $${checkoutTotal.toFixed(2)})`}
            </motion.button>

            <p className="text-center text-xs text-[#6B7280] mt-3">
              {T.testCard}
            </p>
          </motion.div>
        )}

        {started && cart.length === 0 && (
          <div className="bg-[#EFEAE0] border border-dashed border-[#1F3A2E]/15 rounded-2xl px-5 py-6 text-center text-sm text-[#6B7280]">
            {T.cartEmpty}
          </div>
        )}
      </div>
    </div>
  );
}
