"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { motion } from "motion/react";
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

export default function GraphPage() {
  const router = useRouter();
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 800, h: 520 });

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

  return (
    <div className="min-h-screen bg-[#F4F1EA]">
      <div className="px-4 sm:px-6 py-6 sm:py-8 max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-3 mb-6">
          <a
            href="/dashboard"
            className="text-[#1F3A2E] text-sm font-medium hover:opacity-70 transition-opacity min-h-[44px] flex items-center"
          >
            ← Dashboard
          </a>
          <h1 className="font-serif text-[#1F3A2E] text-xl sm:text-2xl font-medium">
            Knowledge Graph
          </h1>
        </div>

        <p className="text-[#6B7280] text-sm mb-5 max-w-xl leading-relaxed">
          A live map of every intake session — symptoms, conditions, and the
          wellness traditions linked to them. Click a node to focus.
        </p>

        {/* Legend */}
        <div className="flex flex-wrap gap-x-4 gap-y-2 mb-4">
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

        {/* Graph + sidebar */}
        <div className="flex flex-col md:flex-row gap-4">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            ref={containerRef}
            className="relative flex-1 rounded-2xl overflow-hidden border border-[#1F3A2E]/15 bg-[#1F3A2E]"
            style={{ height: 520 }}
          >
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
              <div className="text-[#EFEAE0]/60 text-center py-20">Loading graph…</div>
            )}
            <div className="absolute bottom-3 left-0 right-0 text-center text-[10px] text-[#EFEAE0]/40 uppercase tracking-wider pointer-events-none">
              Left-click rotate · scroll zoom · right-click pan
            </div>
          </motion.div>

          {/* Node detail sidebar */}
          {selected && (
            <motion.div
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              className="bg-[#EFEAE0] rounded-2xl p-5 border border-[#1F3A2E]/15"
              style={{ width: 280, flexShrink: 0 }}
            >
              <div className="font-serif text-[#1F3A2E] text-lg font-medium mb-3">
                {selected.name}
              </div>
              <div className="text-xs text-[#6B7280] uppercase tracking-wider mb-1.5">Type</div>
              <div
                className="text-sm font-semibold mb-3"
                style={{ color: TYPE_COLORS[selected.type] ?? "#3D3D3D" }}
              >
                {selected.type}
              </div>
              <div className="text-xs text-[#6B7280] uppercase tracking-wider mb-1.5">ID</div>
              <div className="text-xs text-[#3D3D3D] font-mono break-all mb-4">
                {selected.id}
              </div>
              <button
                onClick={() => setSelected(null)}
                className="w-full text-sm text-[#1F3A2E] border border-[#1F3A2E]/20 rounded-full py-2.5 hover:border-[#1F3A2E]/40 hover:bg-[#1F3A2E]/5 transition-colors min-h-[44px]"
              >
                Close
              </button>
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
}
