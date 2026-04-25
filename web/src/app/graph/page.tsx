"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import type { GraphData, GraphNode } from "@/app/components/ForceGraph3D";

const ForceGraph3D = dynamic(() => import("@/app/components/ForceGraph3D"), { ssr: false });

const FIXTURE: GraphData = {
  nodes: [
    { id: "session-1", name: "Session 1", type: "session", val: 6 },
    { id: "symptom-1", name: "Sore Throat", type: "symptom", val: 8 },
    { id: "symptom-2", name: "Fever", type: "symptom", val: 7 },
    { id: "symptom-3", name: "Headache", type: "symptom", val: 6 },
    { id: "condition-1", name: "Upper Respiratory", type: "condition", val: 5 },
    { id: "session-2", name: "Session 2", type: "session", val: 6 },
    { id: "symptom-4", name: "Anxiety", type: "symptom", val: 7 },
    { id: "symptom-5", name: "Burnout", type: "symptom", val: 6 },
  ],
  links: [
    { source: "session-1", target: "symptom-1", weight: 1 },
    { source: "session-1", target: "symptom-2", weight: 1 },
    { source: "session-1", target: "symptom-3", weight: 1 },
    { source: "symptom-1", target: "condition-1", weight: 1 },
    { source: "symptom-2", target: "condition-1", weight: 1 },
    { source: "session-2", target: "symptom-4", weight: 1 },
    { source: "session-2", target: "symptom-5", weight: 1 },
  ],
};

export default function GraphPage() {
  const router = useRouter();
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 800, h: 600 });

  useEffect(() => {
    fetch("/api/kg")
      .then((r) => r.json())
      .then((data: GraphData) => {
        if (data.nodes?.length) setGraphData(data);
        else setGraphData(FIXTURE);
      })
      .catch(() => setGraphData(FIXTURE));
  }, []);

  useEffect(() => {
    const update = () => {
      if (containerRef.current) {
        setDims({ w: containerRef.current.clientWidth, h: containerRef.current.clientHeight });
      }
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const TYPE_COLORS: Record<string, string> = { session: "#22d3ee", symptom: "#f87171", condition: "#a78bfa", tradition: "#34d399", user: "#fbbf24" };

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{ padding: "16px 24px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 16 }}>
        <a href="/dashboard" style={{ color: "#64748b", fontSize: 14, textDecoration: "none" }}>← Dashboard</a>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Knowledge Graph</h1>
        <div style={{ marginLeft: "auto", display: "flex", gap: 12 }}>
          {Object.entries(TYPE_COLORS).map(([type, color]) => (
            <span key={type} style={{ fontSize: 12, color: "#64748b", display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, display: "inline-block" }} />
              {type}
            </span>
          ))}
        </div>
      </div>

      {/* Main: graph + sidebar */}
      <div style={{ flex: 1, display: "flex" }}>
        <div ref={containerRef} style={{ flex: 1, position: "relative" }}>
          {graphData ? (
            <ForceGraph3D
              graphData={graphData}
              width={dims.w}
              height={dims.h}
              focusNodeId={focusId}
              onNodeClick={(node) => {
                if (node.id.startsWith("run-")) {
                  router.push(`/dashboard?run_id=${node.id.slice(4)}`);
                  return;
                }
                setSelected(node);
                setFocusId(node.id);
              }}
            />
          ) : (
            <div style={{ color: "#64748b", textAlign: "center", padding: 80 }}>Loading graph…</div>
          )}
        </div>

        {/* Node detail sidebar */}
        {selected && (
          <div style={{ width: 260, padding: 24, borderLeft: "1px solid var(--border)", background: "var(--surface)" }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 12 }}>{selected.name}</div>
            <div style={{ fontSize: 13, color: "#64748b", marginBottom: 8 }}>Type: <span style={{ color: TYPE_COLORS[selected.type] ?? "#e2e8f0" }}>{selected.type}</span></div>
            <div style={{ fontSize: 13, color: "#64748b" }}>ID: {selected.id}</div>
            <button onClick={() => setSelected(null)} style={{ marginTop: 16, background: "none", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 16px", color: "#64748b", cursor: "pointer", fontSize: 13 }}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
