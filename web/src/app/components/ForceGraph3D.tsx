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
  description?: string;
  meta?: Record<string, string | number | undefined>;
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
  onNodeHover?: (node: GraphNode | null) => void;
  focusNodeId?: string | null;
  width: number;
  height: number;
}

export default function ForceGraph3D({ graphData, onNodeClick, onNodeHover, focusNodeId, width, height }: Props) {
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
    const hex = TYPE_COLORS[node.type] ?? "#A78BFA";
    // Bigger, more readable spheres
    const size = Math.max(2.8, Math.min(5, (node.val || 3) * 0.85));

    // Inner solid sphere (saturated brand color)
    group.add(new THREE.Mesh(
      new THREE.SphereGeometry(size * 0.7, 32, 32),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(hex), transparent: true, opacity: 1 })
    ));

    // Outer translucent shell — gives a soft rim
    group.add(new THREE.Mesh(
      new THREE.SphereGeometry(size, 32, 32),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(hex),
        transparent: true,
        opacity: 0.25,
        depthWrite: false,
      })
    ));

    // Outer glow halo
    const glowSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: getGlow(hex), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    glowSprite.scale.set(size * 4.2, size * 4.2, 1);
    group.add(glowSprite);

    // Label rendered with a subtle pill background so it's readable on any color
    const lc = document.createElement("canvas");
    const W = 768, H = 96;
    lc.width = W; lc.height = H;
    const lctx = lc.getContext("2d")!;
    const text = (node.name || "").slice(0, 32);
    lctx.font = "500 28px 'DM Sans', 'Inter', sans-serif";
    const metrics = lctx.measureText(text);
    const padX = 22, padY = 12, textW = metrics.width;
    const pillW = Math.min(W - 8, textW + padX * 2);
    const pillH = 44;
    const x0 = (W - pillW) / 2;
    const y0 = (H - pillH) / 2;
    // Pill background (deep sage with low alpha)
    lctx.fillStyle = "rgba(15, 28, 22, 0.78)";
    const r = pillH / 2;
    lctx.beginPath();
    lctx.moveTo(x0 + r, y0);
    lctx.lineTo(x0 + pillW - r, y0);
    lctx.quadraticCurveTo(x0 + pillW, y0, x0 + pillW, y0 + r);
    lctx.lineTo(x0 + pillW, y0 + pillH - r);
    lctx.quadraticCurveTo(x0 + pillW, y0 + pillH, x0 + pillW - r, y0 + pillH);
    lctx.lineTo(x0 + r, y0 + pillH);
    lctx.quadraticCurveTo(x0, y0 + pillH, x0, y0 + pillH - r);
    lctx.lineTo(x0, y0 + r);
    lctx.quadraticCurveTo(x0, y0, x0 + r, y0);
    lctx.fill();

    lctx.fillStyle = "rgba(244, 241, 234, 0.96)";
    lctx.textAlign = "center";
    lctx.textBaseline = "middle";
    lctx.fillText(text, W / 2, H / 2 + padY * 0);

    const labelTex = new THREE.CanvasTexture(lc);
    labelTex.minFilter = THREE.LinearFilter;
    const labelSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: labelTex, transparent: true, depthTest: false })
    );
    const labelScale = size * 5;
    labelSprite.scale.set(labelScale, labelScale * (H / W), 1);
    labelSprite.position.y = size + labelScale * (H / W) * 0.6 + 0.4;
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onNodeHover={(node: any) => {
        if (!onNodeHover) return;
        if (!node) { onNodeHover(null); return; }
        const graphNode = graphData.nodes.find((n) => n.id === node.id);
        if (graphNode) onNodeHover(graphNode);
      }}
      linkColor={() => "rgba(244,241,234,0.18)"}
      linkWidth={0.6}
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
