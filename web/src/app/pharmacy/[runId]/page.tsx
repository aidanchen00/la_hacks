"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { getRun, getBudget, createBudgetCheckout, type CartItem } from "@/lib/api";

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

  // Poll cart whenever we have a runId — works for both fresh searches and post-payment verification
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

  const statusColor = (s: SessionInfo) =>
    s.done ? "#34d399" : s.status === "error" ? "#f87171" : "#a78bfa";

  // Cart helpers
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
    <div style={{ minHeight: "100vh", padding: "32px 24px", maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 28 }}>
        <a href={`/dashboard?run_id=${runId}`} style={{ color: "#64748b", fontSize: 14, textDecoration: "none" }}>← Dashboard</a>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>💊 Pharmacy & Wellness Products</h1>
      </div>

      {/* Payment success banner — verify items match what user paid for */}
      {paymentStatus === "success" && inStockItems.length > 0 && (
        <div style={{ background: "rgba(52,211,153,0.08)", border: "1px solid rgba(52,211,153,0.3)", borderRadius: 12, padding: "16px 20px", marginBottom: 20 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#34d399", marginBottom: 8 }}>
            ✅ Payment Confirmed — Order Verified
          </div>
          <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 12 }}>
            You paid for these {inStockItems.length} items, picked by the agents:
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {inStockItems.map((c) => (
              <div key={c.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#e2e8f0" }}>
                <span><strong>{c.platform}</strong> · {c.item_name}</span>
                <span style={{ color: "#34d399", fontWeight: 600 }}>${c.item_price.toFixed(2)}</span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid rgba(52,211,153,0.2)", paddingTop: 8, marginTop: 4, fontWeight: 700 }}>
              <span style={{ color: "#e2e8f0" }}>Total Paid</span>
              <span style={{ color: "#34d399" }}>${cartTotal.toFixed(2)}</span>
            </div>
          </div>
        </div>
      )}

      {paymentStatus === "cancel" && (
        <div style={{ background: "rgba(248,113,113,0.06)", border: "1px solid rgba(248,113,113,0.2)", borderRadius: 10, padding: "12px 16px", marginBottom: 20, fontSize: 13, color: "#f87171" }}>
          Payment cancelled. Your cart is still here — you can review and try again.
        </div>
      )}

      {/* Disclaimers */}
      <div style={{ background: "rgba(167,139,250,0.06)", border: "1px solid rgba(167,139,250,0.2)", borderRadius: 10, padding: "12px 16px", marginBottom: 16, fontSize: 13, color: "#a78bfa" }}>
        ⚕️ For educational purposes only. Consult a licensed pharmacist or doctor before purchasing any medication.
      </div>

      {requiresDoctorApproval && (
        <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 10, padding: "14px 18px", marginBottom: 20, fontSize: 14, color: "#f87171" }}>
          🔒 <strong>Doctor Approval Required</strong> — Your intake indicates prescription-only items may be needed. Ordering is disabled for your safety.
        </div>
      )}

      {!started ? (
        <div className="card" style={{ maxWidth: 480 }}>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 20 }}>Search Wellness Products</div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 13, color: "#64748b", display: "block", marginBottom: 6 }}>What are you looking for?</label>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={requiresDoctorApproval}
              style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 14px", color: "#e2e8f0", fontSize: 14, opacity: requiresDoctorApproval ? 0.5 : 1 }}
            />
          </div>

          <div style={{ marginBottom: 20, background: "rgba(167,139,250,0.06)", border: "1px solid rgba(167,139,250,0.15)", borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#a78bfa", marginBottom: 10 }}>💰 Budget Allocation</div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
              <label style={{ fontSize: 13, color: "#64748b", minWidth: 80 }}>Total budget</label>
              <input
                type="number"
                min={20} max={500} step={10}
                value={totalBudget}
                onChange={(e) => setTotalBudget(Number(e.target.value))}
                style={{ width: 80, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", color: "#e2e8f0", fontSize: 14, textAlign: "right" }}
              />
              <span style={{ color: "#64748b", fontSize: 13 }}>USD</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
              {["CVS", "Walgreens", "GoodRx"].map((site) => (
                <div key={site} style={{ background: "rgba(255,255,255,0.03)", borderRadius: 6, padding: "6px 10px", fontSize: 12, color: "#94a3b8", textAlign: "center" }}>
                  <div style={{ fontWeight: 600, color: "#e2e8f0" }}>{site}</div>
                  <div style={{ color: "#a78bfa", marginTop: 2 }}>${(totalBudget / 3).toFixed(2)}</div>
                </div>
              ))}
            </div>
          </div>

          <button className="btn-primary" onClick={startSearch} disabled={loading || requiresDoctorApproval}>
            {requiresDoctorApproval ? "Requires Doctor Approval" : loading ? "Launching agents…" : `Search CVS · Walgreens · GoodRx ($${totalBudget})`}
          </button>
        </div>
      ) : (
        <>
          <div style={{ marginBottom: 16, fontSize: 13, color: "#64748b" }}>
            Searching for <strong>{query}</strong> across pharmacies
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 28 }}>
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

      {/* Cart — visible whenever items are present */}
      {cart.length > 0 && (
        <div className="card" style={{ borderColor: "rgba(167,139,250,0.3)" }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>🛒 Your Cart</div>
            <div style={{ marginLeft: "auto", fontSize: 13, color: "#64748b" }}>
              {inStockItems.length} of {cart.length} agent picks in stock
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
            {cart.map((c) => {
              const oos = !c.in_stock || !c.item_name || c.item_price <= 0;
              return (
                <div
                  key={c.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "100px 1fr auto",
                    alignItems: "center",
                    gap: 16,
                    padding: "12px 14px",
                    background: oos ? "rgba(255,255,255,0.02)" : "rgba(167,139,250,0.04)",
                    border: `1px solid ${oos ? "var(--border)" : "rgba(167,139,250,0.2)"}`,
                    borderRadius: 10,
                    opacity: oos ? 0.55 : 1,
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#a78bfa", textTransform: "uppercase", letterSpacing: 0.5 }}>
                    {c.platform}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, color: "#e2e8f0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {c.item_name ?? "No matching product found"}
                    </div>
                    {c.item_description && (
                      <div style={{ fontSize: 12, color: "#64748b", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 2 }}>
                        {c.item_description}
                      </div>
                    )}
                    {oos && (
                      <div style={{ fontSize: 11, color: "#f87171", marginTop: 2 }}>Out of stock — excluded from checkout</div>
                    )}
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: oos ? "#64748b" : "#e2e8f0", textAlign: "right" }}>
                    ${c.item_price.toFixed(2)}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 4px", borderTop: "1px solid var(--border)" }}>
            <div style={{ fontSize: 14, color: "#94a3b8" }}>Total ({inStockItems.length} items)</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: "#a78bfa" }}>${cartTotal.toFixed(2)}</div>
          </div>

          {checkoutError && (
            <div style={{ color: "#f87171", fontSize: 13, marginTop: 8, marginBottom: 8 }}>{checkoutError}</div>
          )}

          <button
            className="btn-primary"
            onClick={handleCheckout}
            disabled={checkoutDisabled}
            style={{ width: "100%", marginTop: 12, opacity: checkoutDisabled ? 0.5 : 1 }}
          >
            {checkoutLoading
              ? "Redirecting to Stripe…"
              : inStockItems.length === 0
                ? "No items available to check out"
                : `Review & Checkout (${inStockItems.length} items · $${cartTotal.toFixed(2)})`}
          </button>

          <div style={{ marginTop: 10, fontSize: 11, color: "#64748b", textAlign: "center" }}>
            Test card: 4242 4242 4242 4242 · any future date · any CVC
          </div>
        </div>
      )}

      {started && cart.length === 0 && (
        <div style={{ marginTop: 8, padding: "20px 16px", textAlign: "center", color: "#64748b", fontSize: 13, background: "var(--surface)", borderRadius: 12, border: "1px dashed var(--border)" }}>
          Cart is empty. Items will appear here as the agents finish their searches.
        </div>
      )}
    </div>
  );
}
