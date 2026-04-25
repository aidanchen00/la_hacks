"use client";

import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { listRuns } from "@/lib/api";
import LanguagePicker from "@/app/components/LanguagePicker";
import dynamic from "next/dynamic";
import { motion, AnimatePresence } from "motion/react";
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

const TYPE_COLORS: Record<string, string> = {
  session: "#7BA8A3",
  symptom: "#DC2626",
  condition: "#A78BFA",
  tradition: "#16A34A",
  user: "#D97706",
};

const TYPE_DESCRIPTIONS: Record<string, string> = {
  session: "An intake session — a conversation you had with Prana.",
  symptom: "A symptom or wellness concern reported in an intake.",
  condition: "A possible underlying condition inferred from symptoms.",
  tradition: "A wellness tradition or alternative-medicine practice.",
  user: "A person — you or another tracked individual.",
};

export default function GraphPage() {
  const router = useRouter();
  const goToDashboard = useCallback(async () => {
    try {
      const runs = await listRuns();
      const latest = Array.isArray(runs) && runs.length > 0 ? runs[0] : null;
      router.push(latest ? `/dashboard?run_id=${latest.id}` : "/dashboard?run_id=demo");
    } catch {
      router.push("/dashboard?run_id=demo");
    }
  }, [router]);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 1000, h: 720 });

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
        setDims({
          w: containerRef.current.clientWidth,
          h: containerRef.current.clientHeight,
        });
      }
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // Compute neighbors for the selected node, for the popup
  const selectedDetails = useMemo(() => {
    if (!selected || !graphData) return null;
    const links = graphData.links.filter((l) => {
      const s = typeof l.source === "object" ? (l.source as { id: string }).id : l.source;
      const t = typeof l.target === "object" ? (l.target as { id: string }).id : l.target;
      return s === selected.id || t === selected.id;
    });
    const neighbors = links.map((l) => {
      const s = typeof l.source === "object" ? (l.source as { id: string }).id : l.source;
      const t = typeof l.target === "object" ? (l.target as { id: string }).id : l.target;
      const otherId = s === selected.id ? t : s;
      return graphData.nodes.find((n) => n.id === otherId);
    }).filter((n): n is GraphNode => !!n);
    return { neighbors, linkCount: links.length };
  }, [selected, graphData]);

  return (
    <div className="min-h-screen bg-[#F4F1EA]">
      <div className="px-4 sm:px-6 py-6 sm:py-8 max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-3 mb-5">
          <button
            onClick={goToDashboard}
            className="text-[#1F3A2E] text-sm font-medium hover:opacity-70 transition-opacity min-h-[44px] flex items-center bg-transparent border-0 cursor-pointer p-0"
          >
            ← Dashboard
          </button>
          <h1 className="font-serif text-[#1F3A2E] text-xl sm:text-2xl font-medium">
            Knowledge Graph
          </h1>

          <div className="ml-auto flex items-center gap-3">
            <div className="hidden md:flex flex-wrap gap-x-4 gap-y-2">
              {Object.entries(TYPE_COLORS).map(([type, color]) => (
                <div
                  key={type}
                  className="flex items-center gap-2 text-xs text-[#6B7280] uppercase tracking-wider font-medium"
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full inline-block"
                    style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}80` }}
                  />
                  {type}
                </div>
              ))}
            </div>
            <LanguagePicker />
          </div>
        </div>

        <p className="text-[#6B7280] text-sm mb-5 max-w-xl leading-relaxed">
          A live map of every intake session — symptoms, conditions, and the
          wellness traditions linked to them. Hover for a quick label, click for details.
        </p>

        {/* Graph (full-width, large) */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          ref={containerRef}
          className="relative w-full rounded-2xl overflow-hidden border border-[#1F3A2E]/15 bg-[#1F3A2E]"
          style={{ height: "min(82vh, 820px)" }}
        >
          {graphData ? (
            <ForceGraph3D
              graphData={graphData}
              width={dims.w}
              height={dims.h}
              focusNodeId={focusId}
              onNodeClick={(node) => {
                setSelected(node);
                setFocusId(node.id);
              }}
              onNodeHover={(node) => setHovered(node)}
            />
          ) : (
            <div className="text-[#EFEAE0]/60 text-center py-32">Loading graph…</div>
          )}

          {/* Hover tooltip — small floating chip in top-left */}
          <AnimatePresence>
            {hovered && (!selected || hovered.id !== selected.id) && (
              <motion.div
                key={`hover-${hovered.id}`}
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.12 }}
                className="absolute top-4 left-4 bg-[#0F1C16]/85 backdrop-blur-sm rounded-xl px-3.5 py-2 pointer-events-none flex items-center gap-2"
              >
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: TYPE_COLORS[hovered.type] ?? "#fff", boxShadow: `0 0 6px ${TYPE_COLORS[hovered.type] ?? "#fff"}` }}
                />
                <span className="text-[#F4F1EA] text-sm font-medium">{hovered.name}</span>
                <span className="text-[#F4F1EA]/50 text-xs uppercase tracking-wider">{hovered.type}</span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Selected popup card — overlay top-right */}
          <AnimatePresence>
            {selected && (
              <motion.div
                key={`sel-${selected.id}`}
                initial={{ opacity: 0, x: 20, scale: 0.96 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: 20, scale: 0.96 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                className="absolute top-4 right-4 bg-[#F4F1EA] rounded-2xl shadow-2xl border border-[#1F3A2E]/15 overflow-hidden"
                style={{ width: 320 }}
              >
                {/* Color stripe */}
                <div
                  className="h-1.5 w-full"
                  style={{ backgroundColor: TYPE_COLORS[selected.type] ?? "#A78BFA" }}
                />
                <div className="p-5">
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full"
                      style={{
                        color: TYPE_COLORS[selected.type] ?? "#1F3A2E",
                        backgroundColor: (TYPE_COLORS[selected.type] ?? "#A78BFA") + "20",
                      }}
                    >
                      {selected.type}
                    </span>
                    <button
                      onClick={() => setSelected(null)}
                      className="ml-auto text-[#6B7280] hover:text-[#1F3A2E] transition-colors text-xl leading-none"
                      aria-label="Close"
                    >
                      ×
                    </button>
                  </div>

                  <div className="font-serif text-[#1F3A2E] text-xl font-medium mb-2 leading-snug">
                    {selected.name}
                  </div>

                  <p className="text-[#3D3D3D] text-xs leading-relaxed mb-2">
                    {selected.description ??
                      TYPE_DESCRIPTIONS[selected.type] ??
                      "A node in your wellness knowledge graph."}
                  </p>

                  {selected.meta && (
                    <div className="flex flex-wrap gap-1.5 mb-4">
                      {Object.entries(selected.meta)
                        .filter(([, v]) => v !== undefined && v !== "" && v !== 0)
                        .slice(0, 6)
                        .map(([k, v]) => (
                          <span
                            key={k}
                            className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-[#EFEAE0] text-[#3D3D3D] border border-[#1F3A2E]/10"
                          >
                            <span className="text-[#6B7280]">{k}:</span> {String(v)}
                          </span>
                        ))}
                    </div>
                  )}

                  {selectedDetails && selectedDetails.linkCount > 0 && (
                    <>
                      <div className="text-[10px] uppercase tracking-wider text-[#6B7280] font-semibold mb-2">
                        Connected to ({selectedDetails.linkCount})
                      </div>
                      <div className="flex flex-wrap gap-1.5 mb-4">
                        {selectedDetails.neighbors.slice(0, 8).map((n) => (
                          <button
                            key={n.id}
                            onClick={() => {
                              setSelected(n);
                              setFocusId(n.id);
                            }}
                            className="text-xs px-2.5 py-1 rounded-full bg-[#EFEAE0] hover:bg-[#1F3A2E]/10 transition-colors border border-[#1F3A2E]/10 flex items-center gap-1.5"
                          >
                            <span
                              className="w-1.5 h-1.5 rounded-full"
                              style={{ backgroundColor: TYPE_COLORS[n.type] ?? "#A78BFA" }}
                            />
                            <span className="text-[#3D3D3D]">
                              {n.name.length > 22 ? n.name.slice(0, 22) + "…" : n.name}
                            </span>
                          </button>
                        ))}
                        {selectedDetails.neighbors.length > 8 && (
                          <span className="text-xs px-2.5 py-1 rounded-full text-[#6B7280]">
                            +{selectedDetails.neighbors.length - 8} more
                          </span>
                        )}
                      </div>
                    </>
                  )}

                  <div className="text-[10px] uppercase tracking-wider text-[#6B7280] font-semibold mb-1">
                    ID
                  </div>
                  <div className="text-[11px] font-mono text-[#3D3D3D]/70 break-all mb-4">
                    {selected.id}
                  </div>

                  {/* Open-session CTA — only for run nodes */}
                  {selected.id.startsWith("run-") && (
                    <button
                      onClick={() => router.push(`/dashboard?run_id=${selected.id.slice(4)}`)}
                      className="w-full bg-[#1F3A2E] text-white rounded-full font-medium text-sm hover:bg-[#2A4D3D] transition-colors py-2.5 flex items-center justify-center gap-1.5"
                    >
                      Open session
                      <span className="text-base leading-none">→</span>
                    </button>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Hint */}
          <div className="absolute bottom-3 left-0 right-0 text-center text-[10px] text-[#EFEAE0]/40 uppercase tracking-wider pointer-events-none">
            Left-click rotate · scroll zoom · right-click pan
          </div>

          {/* Mobile legend */}
          <div className="md:hidden absolute bottom-9 left-0 right-0 flex flex-wrap justify-center gap-x-3 gap-y-1 px-4 pointer-events-none">
            {Object.entries(TYPE_COLORS).map(([type, color]) => (
              <div
                key={type}
                className="flex items-center gap-1.5 text-[10px] text-[#EFEAE0]/70 uppercase tracking-wider"
              >
                <span
                  className="w-1.5 h-1.5 rounded-full inline-block"
                  style={{ backgroundColor: color }}
                />
                {type}
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </div>
  );
}
