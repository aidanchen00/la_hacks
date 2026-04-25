"use client";

import { useEffect } from "react";

export default function AltMedicineError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[alt-medicine error]", error);
  }, [error]);

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, gap: 16 }}>
      <h2 style={{ fontSize: 18, color: "#f87171", margin: 0 }}>Something went wrong loading the global healing map</h2>
      <pre style={{ background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)", borderRadius: 8, padding: 16, fontSize: 12, color: "#fca5a5", maxWidth: 600, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {error.message}
        {error.digest ? `\n\ndigest: ${error.digest}` : ""}
      </pre>
      <div style={{ display: "flex", gap: 12 }}>
        <button onClick={reset} className="btn-primary">Try again</button>
        <a href="/dashboard" style={{ padding: "12px 20px", borderRadius: 9999, border: "1px solid var(--border)", color: "#94a3b8", fontSize: 14, textDecoration: "none" }}>Back to dashboard</a>
      </div>
    </div>
  );
}
