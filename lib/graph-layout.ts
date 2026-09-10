import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
} from "d3-force";

export interface GraphNode {
  id: string;
  accounts: number;
  local: boolean;
  blocked: boolean;
  blockedBy: boolean;
  unreachable: boolean;
  // React Flow's Node<T> requires T to extend Record<string, unknown>.
  [key: string]: unknown;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
}

interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

interface SimLink {
  source: string | SimNode;
  target: string | SimNode;
}

/**
 * Force-directed layout for the federation graph (d3-force). Nodes are sized
 * by their cached account count; the simulation spreads clusters apart so the
 * React Flow canvas looks organic instead of a jumble of overlapping nodes.
 * Deterministic enough for a fixed tick count — positions are relative to the
 * virtual canvas and the flow is fitted with `fitView` on mount.
 */
export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  width = 1400,
  height = 860
): { id: string; x: number; y: number }[] {
  if (nodes.length === 0) return [];

  const simNodes: SimNode[] = nodes.map((n) => ({
    ...n,
    x: width / 2 + (Math.random() - 0.5) * 120,
    y: height / 2 + (Math.random() - 0.5) * 120,
    vx: 0,
    vy: 0,
    radius: Math.min(15 + Math.sqrt(Math.max(n.accounts, 0)) * 1.4, 38),
  }));
  const byId = new Map(simNodes.map((n) => [n.id, n]));

  const simLinks: SimLink[] = edges
    .filter((e) => byId.has(e.source) && byId.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }));

  const simulation = forceSimulation<SimNode>(simNodes)
    .force(
      "link",
      forceLink<SimNode, SimLink>(simLinks)
        .id((d: SimNode) => d.id)
        .distance((l) => {
          const src = typeof l.source === "object" ? (l.source as SimNode).radius : 20;
          const tgt = typeof l.target === "object" ? (l.target as SimNode).radius : 20;
          return 90 + src + tgt;
        })
        .strength(0.35)
    )
    .force("charge", forceManyBody<SimNode>().strength(-320))
    .force("center", forceCenter(width / 2, height / 2))
    .force("collide", forceCollide<SimNode>().radius((d) => d.radius + 16).strength(0.85))
    .stop();

  for (let i = 0; i < 300; i++) simulation.tick();

  return simNodes.map((n) => ({ id: n.id, x: n.x, y: n.y }));
}