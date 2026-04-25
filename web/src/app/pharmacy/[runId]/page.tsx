"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { getRun, getBudget, createBudgetCheckout, type CartItem } from "@/lib/api";
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

  const browserPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cartPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!runId || runId === "no-run") return;
    getRun(runId).then((run) => {
      if (run.routing_decision?.requires_doctor_approval) {
        setRequiresDoctorApproval(true);
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

  const statusDot = (s: SessionInfo) =>
    s.done ? "#16A34A" : s.status === "error" ? "#DC2626" : "#D97706";

  const statusLabel = (s: SessionInfo) =>
    s.done ? "Complete" : s.status === "error" ? "Failed" : "Searching…";

  const inStockItems = cart.filter((c) => c.in_stock && c.item_name && c.item_price > 0);
  const cartTotal = inStockItems.reduce((sum, c) => sum + c.item_price, 0);
  const checkoutDisabled = inStockItems.length === 0 || checkoutLoading || requiresDoctorApproval;

  const handleCheckout = async () => {
    setCheckoutLoading(true);
    setCheckoutError(null);
    try {
      const items = inStockItems.map((c) => ({
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
            ← Dashboard
          </a>
          <h1 className="font-serif text-[#1F3A2E] text-xl sm:text-2xl font-medium">
            Pharmacy & Wellness Products
          </h1>
        </div>

        {/* Payment success banner */}
        {paymentStatus === "success" && inStockItems.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-[#DCFCE7] border border-[#16A34A]/30 rounded-2xl px-5 py-4 mb-5"
          >
            <div className="text-[#16A34A] font-semibold mb-2">✓ Payment Confirmed — Order Verified</div>
            <p className="text-[#6B7280] text-sm mb-3">
              You paid for these {inStockItems.length} items, picked by the agents:
            </p>
            <div className="space-y-1.5">
              {inStockItems.map((c) => (
                <div key={c.id} className="flex justify-between text-sm text-[#3D3D3D]">
                  <span><strong>{c.platform}</strong> · {c.item_name}</span>
                  <span className="text-[#16A34A] font-semibold">${c.item_price.toFixed(2)}</span>
                </div>
              ))}
              <div className="flex justify-between pt-2 mt-1 border-t border-[#16A34A]/20 font-semibold">
                <span className="text-[#3D3D3D]">Total Paid</span>
                <span className="text-[#16A34A]">${cartTotal.toFixed(2)}</span>
              </div>
            </div>
          </motion.div>
        )}

        {paymentStatus === "cancel" && (
          <div className="bg-[#FEE2E2] border border-[#DC2626]/20 rounded-2xl px-5 py-3 mb-5 text-sm text-[#DC2626]">
            Payment cancelled. Your cart is still here — you can review and try again.
          </div>
        )}

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

            <div className="mb-5">
              <label className="block text-sm text-[#6B7280] mb-2">What are you looking for?</label>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                disabled={requiresDoctorApproval}
                className="w-full bg-[#F4F1EA] border border-[#1F3A2E]/20 rounded-xl px-4 py-3 text-[#3D3D3D] focus:outline-none focus:border-[#1F3A2E]/50 disabled:opacity-50"
                style={{ fontSize: 16 }}
              />
            </div>

            <div className="mb-6 bg-[#F4F1EA] border border-[#1F3A2E]/10 rounded-xl p-4">
              <div className="text-xs font-semibold text-[#1F3A2E] uppercase tracking-wider mb-3">
                Budget Allocation
              </div>
              <div className="flex items-center gap-3 mb-3">
                <label className="text-sm text-[#6B7280] flex-shrink-0" style={{ minWidth: 80 }}>Total budget</label>
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
              disabled={loading || requiresDoctorApproval}
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.99 }}
              className="w-full bg-[#1F3A2E] text-white rounded-full font-medium text-sm hover:bg-[#2A4D3D] transition-colors disabled:opacity-40 disabled:cursor-not-allowed min-h-[52px]"
            >
              {requiresDoctorApproval
                ? "Requires Doctor Approval"
                : loading
                  ? "Launching agents…"
                  : `Search CVS · Walgreens · GoodRx ($${totalBudget})`}
            </motion.button>
          </motion.div>
        ) : (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <p className="text-[#6B7280] text-sm mb-4">
              Searching for <strong className="text-[#3D3D3D]">{query}</strong> across pharmacies
            </p>
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

        {/* Cart */}
        {cart.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-[#EFEAE0] rounded-2xl p-6 border border-[#1F3A2E]/15"
          >
            <div className="flex items-center mb-5">
              <h3 className="font-serif text-[#1F3A2E] text-xl font-medium">Your Cart</h3>
              <span className="ml-auto text-xs text-[#6B7280]">
                {inStockItems.length} of {cart.length} agent picks in stock
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
                        {c.item_name ?? "No matching product found"}
                      </div>
                      {c.item_description && (
                        <div className="text-xs text-[#6B7280] truncate mt-0.5">
                          {c.item_description}
                        </div>
                      )}
                      {oos && (
                        <div className="text-xs text-[#DC2626] mt-0.5">
                          Out of stock — excluded from checkout
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
              <span className="text-sm text-[#6B7280]">Total ({inStockItems.length} items)</span>
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
                ? "Redirecting to Stripe…"
                : inStockItems.length === 0
                  ? "No items available to check out"
                  : `Review & Checkout (${inStockItems.length} items · $${cartTotal.toFixed(2)})`}
            </motion.button>

            <p className="text-center text-xs text-[#6B7280] mt-3">
              Test card: 4242 4242 4242 4242 · any future date · any CVC
            </p>
          </motion.div>
        )}

        {started && cart.length === 0 && (
          <div className="bg-[#EFEAE0] border border-dashed border-[#1F3A2E]/15 rounded-2xl px-5 py-6 text-center text-sm text-[#6B7280]">
            Cart is empty. Items will appear here as the agents finish their searches.
          </div>
        )}
      </div>
    </div>
  );
}
