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
        padding: "0.5rem 0.75rem",
        borderRadius: "var(--radius)",
        background: "var(--bg-surface)",
        border: `1px solid ${data.local ? "var(--accent)" : "var(--border)"}`,
        boxShadow: data.local
          ? "0 0 0 2px var(--accent-light), 0 6px 20px rgba(99,102,241,0.25)"
          : "var(--shadow)",
        minWidth: 120,
        maxWidth: 190,
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
          stroke: fromLocal ? "var(--accent-light)" : "var(--border-hover)",
          strokeWidth: Math.min(1 + e.weight / 6, 5),
          opacity: fromLocal ? 0.95 : 0.5,
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
    <main className="force-light graph-page flex flex-col flex-1" style={{ background: "var(--bg)" }}>
      {/* Nav */}
      <nav style={{ position: "sticky", top: 0, zIndex: 40, borderBottom: "1px solid var(--border)", background: "var(--bg-surface)" }}>
        <div className="container-wide flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-4">
          <div className="flex items-center gap-3">
            <Link href="/" style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
              <Image src="/logo.svg" alt="CF ActivityPub" width={36} height={36} />
              <span className="hidden sm:inline font-bold text-lg" style={{ color: "var(--text-primary)" }}>
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

      {/* Header */}
      <section className="container-wide pt-14 pb-6 relative overflow-hidden">
        <div
          style={{
            position: "absolute", inset: 0,
            background: "radial-gradient(ellipse 60% 60% at 50% 0%, rgba(99,102,241,0.12) 0%, transparent 70%)",
            pointerEvents: "none",
          }}
        />
        <div className="relative z-10 flex flex-col items-center text-center gap-4">
          <span className="badge badge-accent">{data?.instance ?? t.graph_title}</span>
          <h1 style={{ fontSize: "clamp(1.8rem, 3.5vw, 2.8rem)", margin: 0 }}>
            {t.graph_title}
          </h1>
          <p style={{ color: "var(--text-secondary)", maxWidth: 620, margin: 0, fontSize: "1rem" }}>
            {t.graph_subtitle}
          </p>

          {/* Stats */}
          <div className="flex flex-wrap justify-center gap-3 mt-2">
            {[
              { icon: "globe", label: t.graph_instances, value: data ? data.nodes.length : null },
              { icon: "share-alt", label: t.graph_connections, value: data ? data.edges.length : null },
              { icon: "users", label: t.graph_accounts, value: data ? totalAccounts : null },
            ].map((s) => (
              <div key={s.label} className="card p-4 flex flex-col items-center gap-1" style={{ minWidth: 120 }}>
                <Icon name={s.icon} size="1.2rem" />
                <span style={{ fontSize: "1.4rem", fontWeight: 800, color: "var(--text-primary)" }}>
                  {s.value === null ? "–" : s.value.toLocaleString()}
                </span>
                <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{s.label}</span>
              </div>
            ))}
          </div>

          {/* Legend */}
          <div className="flex flex-wrap justify-center items-center gap-x-5 gap-y-2 mt-1" style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
            <span className="flex items-center gap-2">
              <span style={{ width: 22, height: 3, borderRadius: 2, background: "var(--border-hover)" }} />
              {t.graph_legend_connection}
            </span>
            <span className="flex items-center gap-2">
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--accent)" }} />
              {t.graph_legend_local}
            </span>
            <span className="flex items-center gap-2">
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--danger)" }} />
              {t.graph_legend_blocked}
            </span>
          </div>
        </div>
      </section>

      {/* Graph canvas */}
      <section className="container-wide flex-1 pb-16" style={{ minHeight: 560 }}>
        <div className="card relative" style={{ height: 620, overflow: "hidden" }}>
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
                fitViewOptions={{ padding: 0.12 }}
                minZoom={0.15}
                maxZoom={2.5}
                nodesDraggable={false}
                nodesConnectable={false}
                proOptions={{ hideAttribution: true }}
                onNodeClick={(_, node) => setSelected(node.data)}
              >
                <Background variant={BackgroundVariant.Dots} gap={20} size={1.4} color="var(--border)" />
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
                  maskColor="rgba(240,240,252,0.75)"
                />
              </ReactFlow>

              {/* Selected-node info card */}
              {selected && (
                <div
                  className="card p-4"
                  style={{
                    position: "absolute",
                    top: 16,
                    left: 16,
                    zIndex: 5,
                    maxWidth: 260,
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.4rem",
                  }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
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
                  <span style={{ fontWeight: 800, color: "var(--text-primary)", wordBreak: "break-word" }}>{selected.id}</span>
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
            </>
          )}
        </div>
        <p style={{ textAlign: "center", color: "var(--text-muted)", fontSize: "0.78rem", marginTop: "0.75rem" }}>
          {t.graph_hint}
        </p>
      </section>

      {/* Footer */}
      <footer style={{ borderTop: "1px solid var(--border)", color: "var(--text-muted)", fontSize: "0.85rem" }}>
        <div className="container-wide flex flex-wrap items-center justify-between gap-4 py-6">
          <span>© {new Date().getFullYear()} CF ActivityPub — {t.landing_footer}</span>
          <div className="flex gap-5">
            <Link href="/" style={{ color: "var(--text-muted)" }}>{t.graph_link}</Link>
            <a href="/docs" style={{ color: "var(--text-muted)" }}>API Docs</a>
            <a href="/.well-known/nodeinfo" style={{ color: "var(--text-muted)" }}>NodeInfo</a>
            <a href="https://github.com/manalejandro/cf-activitypub-next" target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-muted)" }}>GitHub</a>
          </div>
        </div>
      </footer>
    </main>
  );
}