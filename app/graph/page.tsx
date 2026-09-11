"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Position,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node as FlowNode,
  type Edge as FlowEdge,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useLocale } from "@/lib/i18n";
import { useInstanceTitle } from "@/lib/instance-context";
import { useAuth } from "@/lib/client-api";
import { LanguagePicker } from "@/components/LanguagePicker";
import { Icon } from "@/components/Icon";
import { layoutGraph, type GraphNode, type GraphEdge } from "@/lib/graph-layout";

interface GraphData {
  instance: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

type InstanceFlowNode = FlowNode<GraphNode>;

const GLASS: React.CSSProperties = {
  background: "rgba(255,255,255,0.82)",
  backdropFilter: "blur(10px)",
  WebkitBackdropFilter: "blur(10px)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-lg)",
  boxShadow: "var(--shadow-lg)",
};

/** Tiny media-query hook so the floating panels adapt on small screens. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

const InstanceNode = memo(function InstanceNode({ data }: NodeProps<InstanceFlowNode>) {
  const { t } = useLocale();
  const dotColor = data.blocked
    ? "var(--danger)"
    : data.blockedBy
      ? "var(--warning)"
      : data.unreachable
        ? "var(--text-muted)"
        : data.local
          ? "var(--accent)"
          : "var(--success)";
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: "0.2rem",
        padding: "0.45rem 0.75rem",
        borderRadius: "var(--radius)",
        background: "var(--bg-surface)",
        border: `1px solid ${data.local ? "var(--accent)" : data.blockedBy ? "var(--warning)" : data.unreachable ? "var(--text-muted)" : "var(--border)"}`,
        boxShadow: data.local
          ? "0 0 0 2px var(--accent-light), 0 6px 20px rgba(99,102,241,0.28)"
          : data.blockedBy
            ? "0 0 0 2px rgba(251,191,36,0.35), var(--shadow)"
            : "var(--shadow)",
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", minWidth: 0 }}>
        <span
          style={{ width: 10, height: 10, borderRadius: "50%", background: dotColor, flexShrink: 0 }}
        />
        <span
          style={{
            fontWeight: 700,
            fontSize: "0.8rem",
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {data.id}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", minWidth: 0 }}>
        <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
          {data.accounts} {t.graph_accounts.toLowerCase()}
        </span>
        {data.local && (
          <span
            className="badge badge-accent"
            style={{ fontSize: "0.62rem", padding: "0.05rem 0.4rem", marginLeft: "auto" }}
          >
            {t.graph_you}
          </span>
        )}
        {data.blocked && (
          <span
            style={{
              fontSize: "0.62rem",
              padding: "0.05rem 0.4rem",
              borderRadius: "999px",
              background: "rgba(248,113,113,0.12)",
              color: "var(--danger)",
              fontWeight: 600,
              marginLeft: "auto",
            }}
          >
            {t.graph_blocked}
          </span>
        )}
        {data.blockedBy && (
          <span
            style={{
              fontSize: "0.62rem",
              padding: "0.05rem 0.4rem",
              borderRadius: "999px",
              background: "rgba(251,191,36,0.15)",
              color: "var(--warning)",
              fontWeight: 600,
              marginLeft: "auto",
            }}
          >
            {t.graph_blocked_by}
          </span>
        )}
        {data.unreachable && (
          <span
            style={{
              fontSize: "0.62rem",
              padding: "0.05rem 0.4rem",
              borderRadius: "999px",
              background: "rgba(148,163,184,0.15)",
              color: "var(--text-muted)",
              fontWeight: 600,
              marginLeft: "auto",
            }}
          >
            {t.graph_unreachable}
          </span>
        )}
      </div>
    </div>
  );
}, (prev, next) =>
  // Ignore per-frame position changes (xPos/yPos): the card content only
  // depends on the node data, so the rotation never re-renders it.
  prev.data === next.data && prev.selected === next.selected && prev.id === next.id
);

const nodeTypes: NodeTypes = { instance: InstanceNode };

const VIRTUAL_WIDTH = 1400;
const VIRTUAL_HEIGHT = 860;
// Rotation throttling: node-position updates happen at most every 50ms (~20fps).
// Each update makes React Flow re-render every node wrapper and recompute every
// edge path, but the FlowCanvas isolation + memoized callbacks keep that cheap
// (measured ~0.6ms per tick with ~100 nodes). ROTATION_DELTA_PER_FRAME keeps the
// angular speed constant (~50s per full 360°) regardless of the actual frame rate.
const ROTATION_INTERVAL_MS = 50;
const ROTATION_DELTA_PER_FRAME = 0.002;

export default function GraphPage() {
  return (
    <ReactFlowProvider>
      <GraphView />
    </ReactFlowProvider>
  );
}

function GraphView() {
  const { t } = useLocale();
  const brand = useInstanceTitle();
  const { authenticated } = useAuth();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<GraphNode | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/v1/graph")
      .then((res) => (res.ok ? res.json() as Promise<GraphData> : Promise.reject(new Error("graph fetch failed"))))
      .then((d) => { if (alive) setData(d); })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, []);

  const handleNodeClick = useCallback((node: GraphNode) => setSelected(node), []);

  const totalAccounts = useMemo(
    () => (data ? data.nodes.reduce((sum, n) => sum + n.accounts, 0) : 0),
    [data]
  );

  const selectedConnections = useMemo(
    () => (data && selected ? data.edges.filter((e) => e.source === selected.id || e.target === selected.id).length : 0),
    [data, selected]
  );

  return (
    <main className="force-light graph-page" style={{ height: "100dvh", display: "flex", flexDirection: "column", background: "var(--bg)", overflow: "hidden" }}>
      {/* Nav */}
      <nav style={{ position: "relative", zIndex: 20, flexShrink: 0, borderBottom: "1px solid var(--border)", background: "var(--bg-surface)" }}>
        <div className="container-wide flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
          <div className="flex items-center gap-3">
            <Link href="/" style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
              <Image src="/logo.svg" alt={brand} width={32} height={32} />
              <span className="hidden sm:inline font-bold text-base" style={{ color: "var(--text-primary)" }}>
                {brand}
              </span>
            </Link>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <LanguagePicker />
            {authenticated ? (
              <Link href="/home" className="btn btn-primary btn-sm">{t.nav_home}</Link>
            ) : (
              <>
                <Link href="/login" className="btn btn-outline btn-sm">{t.landing_signin}</Link>
                <Link href="/register" className="btn btn-primary btn-sm">{t.landing_join}</Link>
              </>
            )}
          </div>
        </div>
      </nav>

      {/* Graph fills the whole remaining page; panels float over it */}
      <div className="relative flex-1" style={{ minHeight: 0 }}>
        {error ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <Icon name="exclamation-triangle" size="2rem" color="var(--danger)" />
            <p style={{ color: "var(--text-secondary)" }}>{t.network_error}</p>
          </div>
        ) : !data ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <Icon name="refresh" size="2rem" spin />
            <p style={{ color: "var(--text-secondary)" }}>{t.graph_loading}</p>
          </div>
        ) : data.nodes.length <= 1 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
            <Icon name="globe" size="2rem" />
            <p style={{ color: "var(--text-secondary)", maxWidth: 420 }}>{t.graph_empty}</p>
          </div>
        ) : (
          <>
            {/* The flow lives in its own component so the rotation (which updates
                node positions ~5×/s) only re-renders the canvas, never the page
                chrome above. */}
            <FlowCanvas data={data} onNodeClick={handleNodeClick} />

            {/* Floating header panel */}
            <div style={{ ...GLASS, position: "absolute", top: 16, left: 16, zIndex: 10, maxWidth: isMobile ? "calc(100vw - 2rem)" : 320, display: "flex", flexDirection: "column", gap: isMobile ? "0.5rem" : "0.7rem", padding: isMobile ? "0.75rem 0.9rem" : "1rem 1.1rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <Icon name="share-alt" size="1.1rem" />
                <span style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {data.instance}
                </span>
              </div>
              <h1 style={{ fontSize: isMobile ? "1.1rem" : "1.35rem", margin: 0, color: "var(--text-primary)" }}>{t.graph_title}</h1>
              {!isMobile && <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", margin: 0 }}>{t.graph_subtitle}</p>}
              <div className="flex gap-2" style={{ flexWrap: "wrap" }}>
                {[
                  { icon: "globe", label: t.graph_instances, value: data.nodes.length },
                  { icon: "share-alt", label: t.graph_connections, value: data.edges.length },
                  { icon: "users", label: t.graph_accounts, value: totalAccounts },
                ].map((s) => (
                  <div key={s.label} style={{ flex: "1 1 0", minWidth: isMobile ? 72 : 86, display: "flex", flexDirection: "column", alignItems: "center", gap: "0.1rem", padding: isMobile ? "0.4rem 0.3rem" : "0.5rem 0.4rem", borderRadius: "var(--radius)", background: "rgba(244,244,255,0.7)", border: "1px solid var(--border)" }}>
                    <span style={{ fontSize: isMobile ? "0.95rem" : "1.05rem", fontWeight: 800, color: "var(--text-primary)" }}>{s.value.toLocaleString()}</span>
                    <span style={{ fontSize: isMobile ? "0.6rem" : "0.68rem", color: "var(--text-muted)", textAlign: "center" }}>{s.label}</span>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1" style={{ fontSize: isMobile ? "0.66rem" : "0.72rem", color: "var(--text-muted)" }}>
                <span className="flex items-center gap-1.5">
                  <span style={{ width: 20, height: 3, borderRadius: 2, background: "var(--accent)" }} />
                  {t.graph_legend_connection}
                </span>
                <span className="flex items-center gap-1.5">
                  <span style={{ width: 9, height: 9, borderRadius: "50%", background: "var(--accent)" }} />
                  {t.graph_legend_local}
                </span>
                <span className="flex items-center gap-1.5">
                  <span style={{ width: 9, height: 9, borderRadius: "50%", background: "var(--danger)" }} />
                  {t.graph_legend_blocked}
                </span>
                <span className="flex items-center gap-1.5">
                  <span style={{ width: 9, height: 9, borderRadius: "50%", background: "var(--warning)" }} />
                  {t.graph_legend_blocked_by}
                </span>
                <span className="flex items-center gap-1.5">
                  <span style={{ width: 9, height: 9, borderRadius: "50%", background: "var(--text-muted)" }} />
                  {t.graph_legend_unreachable}
                </span>
              </div>
            </div>

            {/* Selected-node info card */}
            {selected && (
              <div style={{ ...GLASS, position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)", zIndex: 10, maxWidth: isMobile ? "calc(100vw - 2rem)" : 320, display: "flex", flexDirection: "column", gap: "0.4rem", padding: "0.9rem 1rem" }}>
                <div className="flex items-center justify-between gap-3">
                  <span style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    {t.graph_node_details}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelected(null)}
                    className="btn btn-ghost btn-sm"
                    style={{ padding: "0.1rem 0.3rem", color: "var(--text-muted)" }}
                    aria-label={t.action_close}
                  >
                    <Icon name="times" size="0.8rem" />
                  </button>
                </div>
                <span style={{ fontWeight: 800, color: "var(--text-primary)", wordBreak: "break-word", fontSize: "0.95rem" }}>{selected.id}</span>
                <div className="flex flex-wrap items-center gap-2" style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                  <span>{selected.accounts} {t.graph_accounts.toLowerCase()}</span>
                  <span>·</span>
                  <span>{selectedConnections} {t.graph_connections.toLowerCase()}</span>
                  {selected.local && <span className="badge badge-accent">{t.graph_you}</span>}
                  {selected.blocked && (
                    <span style={{ fontSize: "0.7rem", padding: "0.05rem 0.4rem", borderRadius: "999px", background: "rgba(248,113,113,0.12)", color: "var(--danger)", fontWeight: 600 }}>
                      {t.graph_blocked}
                    </span>
                  )}
                  {selected.blockedBy && (
                    <span style={{ fontSize: "0.7rem", padding: "0.05rem 0.4rem", borderRadius: "999px", background: "rgba(251,191,36,0.15)", color: "var(--warning)", fontWeight: 600 }}>
                      {t.graph_blocked_by}
                    </span>
                  )}
                  {selected.unreachable && (
                    <span style={{ fontSize: "0.7rem", padding: "0.05rem 0.4rem", borderRadius: "999px", background: "rgba(148,163,184,0.15)", color: "var(--text-muted)", fontWeight: 600 }}>
                      {t.graph_unreachable}
                    </span>
                  )}
                  {selected.lastError && (
                    <span style={{ width: "100%", fontSize: "0.72rem", color: "var(--text-muted)", fontFamily: "monospace" }}>
                      {selected.lastError}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Hint — desktop only, top-right (clear of Controls/MiniMap). On mobile the
              touch gestures are self-explanatory and space is scarce. */}
            {!isMobile && (
              <div style={{ position: "absolute", top: 16, right: 16, zIndex: 10, ...GLASS, padding: "0.4rem 0.8rem", fontSize: "0.72rem", color: "var(--text-muted)" }}>
                {t.graph_hint}
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

/**
 * The React Flow canvas on its own. Isolating it here means the slow rotation
 * (which mutates node positions ~5×/s) re-renders ONLY the canvas — the nav and
 * floating panels in GraphView stay untouched, which is what keeps the page
 * light with 100 nodes + edges.
 */
function FlowCanvas({ data, onNodeClick }: { data: GraphData; onNodeClick: (node: GraphNode) => void }) {
  const { fitView } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<InstanceFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);

  const draggingRef = useRef(false);
  const centroidRef = useRef<{ x: number; y: number } | null>(null);

  // Build nodes + edges once the data arrives. Nodes get explicit
  // width/height + source/target handles so React Flow initializes them (and
  // therefore draws the edges) deterministically, without relying on the
  // ResizeObserver measuring them.
  useEffect(() => {
    if (data.nodes.length <= 1) return;
    const positions = layoutGraph(data.nodes, data.edges, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
    const byId = new Map(data.nodes.map((n) => [n.id, n]));

    // Rotation center: the bounding-box centroid of the initial layout.
    let cx = 0;
    let cy = 0;
    for (const p of positions) { cx += p.x; cy += p.y; }
    centroidRef.current = { x: cx / positions.length, y: cy / positions.length };

    setNodes(
      positions.map((p) => {
        const n = byId.get(p.id);
        const id = p.id;
        const width = Math.min(210, Math.max(140, id.length * 7.5 + 36));
        const height = 54;
        return {
          id,
          type: "instance",
          position: { x: p.x, y: p.y },
          width,
          height,
          handles: [
            { id: "source", type: "source", position: Position.Bottom, x: width / 2, y: height },
            { id: "target", type: "target", position: Position.Top, x: width / 2, y: 0 },
          ],
          data: n ?? { id, accounts: 0, local: false, blocked: false, blockedBy: false, unreachable: false },
        };
      })
    );
    const nodeIds = new Set(byId.keys());
    setEdges(
      data.edges
        .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
        .map((e, i) => {
          const fromLocal = e.source === data.instance || e.target === data.instance;
          // Colour the connection by the TARGET instance's state: red when we
          // block it, amber when it blocks us, accent when it touches our own
          // instance, neutral otherwise.
          const targetNode = byId.get(e.target);
          let stroke = "#7a7aaa";
          let animated = false;
          if (targetNode?.blocked) stroke = "var(--danger)";
          else if (targetNode?.blockedBy) stroke = "var(--warning)";
          else if (targetNode?.unreachable) stroke = "var(--text-muted)";
          else if (fromLocal) {
            stroke = "var(--accent)";
            animated = true;
          }
          return {
            id: `edge-${i}`,
            source: e.source,
            target: e.target,
            animated,
            style: {
              stroke,
              strokeWidth: fromLocal ? 3 : Math.min(1.6 + e.weight / 6, 4.5),
              opacity: 0.9,
            },
          };
        })
    );
  }, [data, setNodes, setEdges]);

  // Fit the graph into the viewport once populated.
  useEffect(() => {
    if (nodes.length === 0) return;
    const id = requestAnimationFrame(() => fitView({ padding: 0.18, duration: 600 }));
    return () => cancelAnimationFrame(id);
  }, [nodes.length, fitView]);

  // Slow 360° rotation at ~5fps: rotate node positions around the centroid by a
  // constant angular delta. Rotation is a rigid transform around the centroid,
  // so the graph spins in place (no drift) and edges follow the nodes. Paused
  // while the user drags a node.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let pending = 0;
    const tick = (now: number) => {
      const c = centroidRef.current;
      const dt = now - last;
      last = now;
      if (c && !draggingRef.current) {
        pending += dt;
        if (pending >= ROTATION_INTERVAL_MS) {
          const steps = pending / 16.6667;
          pending = 0;
          const a = ROTATION_DELTA_PER_FRAME * steps;
          const cos = Math.cos(a);
          const sin = Math.sin(a);
          setNodes((nds) =>
            nds.map((n) => {
              const dx = n.position.x - c.x;
              const dy = n.position.y - c.y;
              return { ...n, position: { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos } };
            })
          );
        }
      } else {
        pending = 0; // don't accumulate while the user is dragging
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [setNodes]);

  // Memoized handlers so React Flow never re-creates them on rotation ticks.
  const handleNodeClick = useCallback((_: unknown, node: InstanceFlowNode) => onNodeClick(node.data), [onNodeClick]);
  const handleDragStart = useCallback(() => { draggingRef.current = true; }, []);
  const handleDragStop = useCallback(() => { draggingRef.current = false; }, []);
  const minimapColor = useCallback((n: { data?: unknown }) => {
    const d = n.data as GraphNode | undefined;
    if (d?.blocked) return "var(--danger)";
    if (d?.blockedBy) return "var(--warning)";
    if (d?.unreachable) return "var(--text-muted)";
    if (d?.local) return "var(--accent)";
    return "var(--border-hover)";
  }, []);

  return (
    <div className="absolute inset-0">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        minZoom={0.1}
        maxZoom={3}
        nodesConnectable={false}
        elementsSelectable
        selectionOnDrag={false}
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        onNodeDragStart={handleDragStart}
        onNodeDragStop={handleDragStop}
        proOptions={{ hideAttribution: true }}
        onNodeClick={handleNodeClick}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} color="var(--border)" />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={minimapColor} maskColor="rgba(240,240,252,0.7)" />
      </ReactFlow>
    </div>
  );
}