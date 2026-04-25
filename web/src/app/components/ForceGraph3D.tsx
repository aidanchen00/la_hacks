"use client";

import { useRef, useCallback, useMemo, useEffect } from "react";
import dynamic from "next/dynamic";
import * as THREE from "three";

const ForceGraph3DComponent = dynamic(
  () => import("react-force-graph-3d").then((mod) => mod.default || mod),
  { ssr: false }
);

export interface GraphNode {
  id: string;
  name: string;
  type: string;
  val?: number;
}

export interface GraphData {
  nodes: GraphNode[];
  links: { source: string; target: string; weight?: number }[];
}

const TYPE_COLORS: Record<string, string> = {
  session: "#22d3ee",
  symptom: "#f87171",
  condition: "#a78bfa",
  tradition: "#34d399",
  user: "#fbbf24",
};

interface Props {
  graphData: GraphData;
  onNodeClick?: (node: GraphNode) => void;
  focusNodeId?: string | null;
  width: number;
  height: number;
}

export default function ForceGraph3D({ graphData, onNodeClick, focusNodeId, width, height }: Props) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  const hasZoomedRef = useRef(false);

  useEffect(() => { hasZoomedRef.current = false; }, [graphData.nodes.length]);

  // Configure d3 forces for a compact, readable graph
  useEffect(() => {
    const t = setTimeout(() => {
      const fg = fgRef.current;
      if (!fg) return;
      fg.d3Force("link")?.distance(30).strength(0.8);
      fg.d3Force("charge")?.strength(-60);
      fg.d3Force("center")?.strength(0.5);
      fg.d3ReheatSimulation?.();
    }, 150);
    return () => clearTimeout(t);
  }, [graphData.nodes.length]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fgRef.current?.zoomToFit?.(1000, 40);
      hasZoomedRef.current = true;
    }, 2000);
    return () => clearTimeout(timer);
  }, [graphData.nodes.length]);

  const data = useMemo(() => ({
    nodes: graphData.nodes.map((n) => ({ ...n })),
    links: graphData.links.map((l) => ({
      ...l,
      source: typeof l.source === "object" ? (l.source as { id: string }).id : l.source,
      target: typeof l.target === "object" ? (l.target as { id: string }).id : l.target,
    })),
  }), [graphData]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dataNodesRef = useRef<any[]>([]);
  dataNodesRef.current = data.nodes;

  useEffect(() => {
    if (!focusNodeId) return;
    const fg = fgRef.current;
    const attempt = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const node = dataNodesRef.current.find((n: any) => n.id === focusNodeId);
      if (!node) return false;
      const x: number = node.x ?? 0, y: number = node.y ?? 0, z: number = node.z ?? 0;
      if (Math.hypot(x, y, z) < 1) return false;
      const distRatio = 1 + 40 / Math.hypot(x, y, z);
      fg?.cameraPosition?.({ x: x * distRatio, y: y * distRatio, z: z * distRatio }, { x, y, z }, 1000);
      return true;
    };
    if (!attempt()) { const t = setTimeout(attempt, 500); return () => clearTimeout(t); }
  }, [focusNodeId]);

  const glowCache = useRef<Map<string, THREE.Texture>>(new Map());
  const getGlow = useCallback((hex: string) => {
    if (glowCache.current.has(hex)) return glowCache.current.get(hex)!;
    const s = 256, c = document.createElement("canvas");
    c.width = s; c.height = s;
    const ctx = c.getContext("2d")!;
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, hex + "80"); g.addColorStop(0.35, hex + "18"); g.addColorStop(1, hex + "00");
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    const tex = new THREE.CanvasTexture(c);
    glowCache.current.set(hex, tex);
    return tex;
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createNode = useCallback((node: any) => {
    const group = new THREE.Group();
    const hex = TYPE_COLORS[node.type] ?? "#818cf8";
    // Keep nodes small and uniform — val is 1–5, size stays 1.5–3
    const size = Math.max(1.5, Math.min(3, (node.val || 3) * 0.55));

    group.add(new THREE.Mesh(
      new THREE.SphereGeometry(size, 24, 24),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(hex), transparent: true, opacity: 0.9 })
    ));

    const glowSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: getGlow(hex), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    glowSprite.scale.set(size * 2.5, size * 2.5, 1);
    group.add(glowSprite);

    const lc = document.createElement("canvas");
    lc.width = 512; lc.height = 64;
    const lctx = lc.getContext("2d")!;
    lctx.font = "400 18px Inter, sans-serif";
    lctx.fillStyle = "rgba(226,232,240,0.75)";
    lctx.textAlign = "center"; lctx.textBaseline = "middle";
    lctx.fillText((node.name || "").slice(0, 28), 256, 32);
    const labelSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(lc), transparent: true, depthTest: false })
    );
    labelSprite.scale.set(size * 5, size * 5 * (64 / 512), 1);
    labelSprite.position.y = size + 1.5;
    group.add(labelSprite);
    return group;
  }, [getGlow]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleClick = useCallback((node: any) => {
    const graphNode = graphData.nodes.find((n) => n.id === node.id);
    if (graphNode && onNodeClick) onNodeClick(graphNode);
    const fg = fgRef.current;
    const dist = 200, ratio = 1 + dist / Math.hypot(node.x || 0, node.y || 0, node.z || 0);
    fg?.cameraPosition?.({ x: (node.x || 0) * ratio, y: (node.y || 0) * ratio, z: (node.z || 0) * ratio }, { x: node.x || 0, y: node.y || 0, z: node.z || 0 }, 1000);
  }, [graphData, onNodeClick]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const FG = ForceGraph3DComponent as any;
  if (!data.nodes.length) return <div style={{ color: "#64748b", textAlign: "center", padding: 60 }}>No graph data yet — complete a voice intake first.</div>;

  return (
    <FG
      ref={fgRef}
      graphData={data}
      width={width}
      height={height}
      backgroundColor="#1F3A2E"
      nodeThreeObject={createNode}
      nodeThreeObjectExtend={false}
      onNodeClick={handleClick}
      linkColor={() => "rgba(148,163,184,0.1)"}
      linkWidth={0.3}
      linkDirectionalParticles={1}
      linkDirectionalParticleWidth={0.8}
      linkDirectionalParticleSpeed={0.004}
      d3AlphaDecay={0.015}
      d3VelocityDecay={0.4}
      warmupTicks={120}
      cooldownTime={4000}
      onEngineStop={() => {
        if (hasZoomedRef.current) return;
        fgRef.current?.zoomToFit?.(800, graphData.nodes.length <= 5 ? -40 : 20);
        hasZoomedRef.current = true;
      }}
    />
  );
}
