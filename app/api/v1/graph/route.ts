import { getCloudflareContext, json } from "@/lib/cf";
import { resolveLimits } from "@/lib/constants";

interface EdgeRow {
  source: string;
  target: string;
  weight: number;
}

const MAX_EDGES = 250;

/**
 * GET /api/v1/graph — the federation network this instance is connected to.
 * Nodes are domains (instances), edges are follower relationships between
 * accounts on different domains, weighted by how many follows link the pair.
 * Bounded for readability: the strongest inter-instance connections win, the
 * local instance is always present, and reciprocal edges are merged. The node
 * cap is configurable via GRAPH_MAX_NODES (wrangler var, default 100).
 */
export async function GET(): Promise<Response> {
  const { env } = getCloudflareContext();
  const maxNodes = resolveLimits(env as unknown as Record<string, unknown>).graphMaxNodes;
  const instanceDomain = (
    (env.INSTANCE_URL ? new URL(env.INSTANCE_URL).hostname : "") || "localhost"
  ).toLowerCase();

  // Candidate edges: strongest inter-domain follower pairs across the whole DB.
  const edges = await env.DB
    .prepare(
      `SELECT a.domain AS source, b.domain AS target, COUNT(*) AS weight
       FROM follows f
       JOIN actors a ON a.id = f.actor_id
       JOIN actors b ON b.id = f.target_id
       WHERE a.domain <> b.domain
       GROUP BY a.domain, b.domain
       ORDER BY weight DESC
       LIMIT ?`
    )
    .bind(MAX_EDGES)
    .all<EdgeRow>();

  const nodeSet = new Set<string>([instanceDomain]);
  for (const e of edges.results) {
    nodeSet.add(e.source);
    nodeSet.add(e.target);
    if (nodeSet.size >= maxNodes) break;
  }
  // Instances that have rejected our deliveries with 403 Forbidden — the
  // classic signal that a remote instance has blocked us. Only shown while the
  // most recent delivery to the domain was a rejection (a later success clears
  // it). Surfaced as their own nodes even without a follower connection.
  const blockedByRows = await env.DB
    .prepare(
      `SELECT domain FROM delivery_rejections
       WHERE status = 403
         AND (last_ok_at IS NULL OR last_at > last_ok_at)`
    )
    .all<{ domain: string }>();
  for (const row of blockedByRows.results) {
    nodeSet.add(row.domain);
    if (nodeSet.size >= maxNodes) break;
  }
  // D1 caps the number of bind variables (~100), so the IN lists are passed as
  // one JSON array and expanded with json_each instead of one placeholder per
  // domain (2×nodes placeholders on the edges query would exceed the limit).
  const nodeList = [...nodeSet];
  const nodeJson = JSON.stringify(nodeList);

  const [accountsRows, blockedRows, finalEdges] = await Promise.all([
    env.DB
      .prepare(
        `SELECT domain, COUNT(*) AS accounts FROM actors
         WHERE domain IN (SELECT value FROM json_each(?))
         GROUP BY domain`
      )
      .bind(nodeJson)
      .all<{ domain: string; accounts: number }>(),
    env.DB
      .prepare(
        `SELECT domain FROM instance_domain_blocks
         WHERE domain IN (SELECT value FROM json_each(?))`
      )
      .bind(nodeJson)
      .all<{ domain: string }>(),
    env.DB
      .prepare(
        `SELECT a.domain AS source, b.domain AS target, COUNT(*) AS weight
         FROM follows f
         JOIN actors a ON a.id = f.actor_id
         JOIN actors b ON b.id = f.target_id
         WHERE a.domain <> b.domain
           AND a.domain IN (SELECT value FROM json_each(?))
           AND b.domain IN (SELECT value FROM json_each(?))
         GROUP BY a.domain, b.domain
         ORDER BY weight DESC
         LIMIT ?`
      )
      .bind(nodeJson, nodeJson, MAX_EDGES)
      .all<EdgeRow>(),
  ]);

  const accountsByDomain = new Map(accountsRows.results.map((r) => [r.domain, Number(r.accounts)]));
  const blockedSet = new Set(blockedRows.results.map((r) => r.domain));
  const blockedBySet = new Set(blockedByRows.results.map((r) => r.domain));

  // Merge reciprocal edges (a→b and b→a) into a single undirected connection.
  const merged = new Map<string, { source: string; target: string; weight: number }>();
  for (const e of finalEdges.results) {
    const key = [e.source, e.target].sort().join("\u0000");
    const existing = merged.get(key);
    if (existing) {
      existing.weight += Number(e.weight);
    } else {
      merged.set(key, { source: e.source, target: e.target, weight: Number(e.weight) });
    }
  }

  return json({
    instance: instanceDomain,
    nodes: nodeList.map((d) => ({
      id: d,
      accounts: accountsByDomain.get(d) ?? 0,
      local: d === instanceDomain,
      blocked: blockedSet.has(d),
      blockedBy: blockedBySet.has(d),
    })),
    edges: [...merged.values()].sort((a, b) => b.weight - a.weight).slice(0, MAX_EDGES),
  });
}