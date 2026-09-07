"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  type Node as FlowNode,
  type Edge as FlowEdge,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useLocale } from "@/lib/i18n";
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

function InstanceNode({ data }: NodeProps<InstanceFlowNode>) {
  const { t } = useLocale();
  const dotColor = data.blocked
    ? "var(--danger)"
    : data.local
      ? "var(--accent)"
      : "var(--success)";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.25rem",
        padding: "0.5rem 0.8rem",
        borderRadius: "var(--radius)",
        background: "var(--bg-surface)",
        border: `1px solid ${data.local ? "var(--accent)" : "var(--border)"}`,
        boxShadow: data.local
          ? "0 0 0 2px var(--accent-light), 0 6px 20px rgba(99,102,241,0.28)"
          : "var(--shadow)",
        minWidth: 126,
        maxWidth: 200,
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
      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
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
      </div>
    </div>
  );
}

const nodeTypes: NodeTypes = { instance: InstanceNode };

const VIRTUAL_WIDTH = 1400;
const VIRTUAL_HEIGHT = 860;

export default function GraphPage() {
  const { t } = useLocale();
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

  const nodes: InstanceFlowNode[] = useMemo(() => {
    if (!data) return [];
    const positions = layoutGraph(data.nodes, data.edges, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    return positions.map((p) => {
      const n = byId.get(p.id);
      if (!n) return { id: p.id, type: "instance", position: { x: p.x, y: p.y }, data: { id: p.id, accounts: 0, local: false, blocked: false } };
      return { id: p.id, type: "instance", position: { x: p.x, y: p.y }, data: n };
    });
  }, [data]);

  // Edges rendered clearly: connections from the local instance are accent-coloured
  // and animated, the rest use a solid mid tone — both clearly visible on the
  // light canvas, with the stroke scaling by follow weight.
  const edges: FlowEdge[] = useMemo(() => {
    if (!data) return [];
    return data.edges.map((e, i) => {
      const fromLocal = e.source === data.instance || e.target === data.instance;
      return {
        id: `edge-${i}`,
        source: e.source,
        target: e.target,
        animated: fromLocal,
        style: {
          stroke: fromLocal ? "var(--accent)" : "#8a8ab8",
          strokeWidth: fromLocal ? 2.5 : Math.min(1.5 + e.weight / 8, 4),
          opacity: 0.85,
        },
      };
    });
  }, [data]);

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
              <Image src="/logo.svg" alt="CF ActivityPub" width={32} height={32} />
              <span className="hidden sm:inline font-bold text-base" style={{ color: "var(--text-primary)" }}>
                CF ActivityPub
              </span>
            </Link>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <LanguagePicker />
            <Link href="/login" className="btn btn-outline btn-sm">{t.landing_signin}</Link>
            <Link href="/register" className="btn btn-primary btn-sm">{t.landing_join}</Link>
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
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.18 }}
              minZoom={0.1}
              maxZoom={3}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable
              selectionOnDrag={false}
              panOnDrag
              zoomOnScroll
              zoomOnPinch
              proOptions={{ hideAttribution: true }}
              onNodeClick={(_, node) => setSelected(node.data)}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} color="var(--border)" />
              <Controls showInteractive={false} />
              <MiniMap
                pannable
                zoomable
                nodeColor={(n) => {
                  const d = n.data as GraphNode | undefined;
                  if (d?.blocked) return "var(--danger)";
                  if (d?.local) return "var(--accent)";
                  return "var(--border-hover)";
                }}
                maskColor="rgba(240,240,252,0.7)"
              />
            </ReactFlow>

            {/* Floating header panel */}
            <div style={{ ...GLASS, position: "absolute", top: 16, left: 16, zIndex: 10, maxWidth: 320, display: "flex", flexDirection: "column", gap: "0.7rem", padding: "1rem 1.1rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <Icon name="share-alt" size="1.1rem" />
                <span style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {data.instance}
                </span>
              </div>
              <h1 style={{ fontSize: "1.35rem", margin: 0, color: "var(--text-primary)" }}>{t.graph_title}</h1>
              <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", margin: 0 }}>{t.graph_subtitle}</p>
              <div className="flex gap-2" style={{ flexWrap: "wrap" }}>
                {[
                  { icon: "globe", label: t.graph_instances, value: data.nodes.length },
                  { icon: "share-alt", label: t.graph_connections, value: data.edges.length },
                  { icon: "users", label: t.graph_accounts, value: totalAccounts },
                ].map((s) => (
                  <div key={s.label} style={{ flex: "1 1 0", minWidth: 86, display: "flex", flexDirection: "column", alignItems: "center", gap: "0.1rem", padding: "0.5rem 0.4rem", borderRadius: "var(--radius)", background: "rgba(244,244,255,0.7)", border: "1px solid var(--border)" }}>
                    <span style={{ fontSize: "1.05rem", fontWeight: 800, color: "var(--text-primary)" }}>{s.value.toLocaleString()}</span>
                    <span style={{ fontSize: "0.68rem", color: "var(--text-muted)", textAlign: "center" }}>{s.label}</span>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5" style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
                <span className="flex items-center gap-1.5">
                  <span style={{ width: 22, height: 3, borderRadius: 2, background: "var(--accent)" }} />
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
              </div>
            </div>

            {/* Selected-node info card */}
            {selected && (
              <div style={{ ...GLASS, position: "absolute", bottom: 16, left: 16, zIndex: 10, maxWidth: 280, display: "flex", flexDirection: "column", gap: "0.4rem", padding: "0.9rem 1rem" }}>
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
                </div>
              </div>
            )}

            {/* Hint */}
            <div style={{ position: "absolute", bottom: 16, right: 16, zIndex: 10, ...GLASS, padding: "0.4rem 0.8rem", fontSize: "0.72rem", color: "var(--text-muted)" }}>
              {t.graph_hint}
            </div>
          </>
        )}
      </div>
    </main>
  );
}