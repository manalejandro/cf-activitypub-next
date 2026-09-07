import { getCloudflareContext, json } from "@/lib/cf";

interface EdgeRow {
  source: string;
  target: string;
  weight: number;
}

const MAX_NODES = 60;
const MAX_EDGES = 250;

/**
 * GET /api/v1/graph — the federation network this instance is connected to.
 * Nodes are domains (instances), edges are follower relationships between
 * accounts on different domains, weighted by how many follows link the pair.
 * Bounded for readability: the strongest inter-instance connections win, the
 * local instance is always present, and reciprocal edges are merged.
 */
export async function GET(): Promise<Response> {
  const { env } = getCloudflareContext();
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
    if (nodeSet.size >= MAX_NODES) break;
  }
  const nodeList = [...nodeSet];
  const ph = nodeList.map(() => "?").join(",");

  const [accountsRows, blockedRows, finalEdges] = await Promise.all([
    env.DB
      .prepare(`SELECT domain, COUNT(*) AS accounts FROM actors WHERE domain IN (${ph}) GROUP BY domain`)
      .bind(...nodeList)
      .all<{ domain: string; accounts: number }>(),
    env.DB
      .prepare(`SELECT domain FROM instance_domain_blocks WHERE domain IN (${ph})`)
      .bind(...nodeList)
      .all<{ domain: string }>(),
    env.DB
      .prepare(
        `SELECT a.domain AS source, b.domain AS target, COUNT(*) AS weight
         FROM follows f
         JOIN actors a ON a.id = f.actor_id
         JOIN actors b ON b.id = f.target_id
         WHERE a.domain <> b.domain
           AND a.domain IN (${ph})
           AND b.domain IN (${ph})
         GROUP BY a.domain, b.domain
         ORDER BY weight DESC
         LIMIT ?`
      )
      .bind(...nodeList, ...nodeList, MAX_EDGES)
      .all<EdgeRow>(),
  ]);

  const accountsByDomain = new Map(accountsRows.results.map((r) => [r.domain, Number(r.accounts)]));
  const blockedSet = new Set(blockedRows.results.map((r) => r.domain));

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
    })),
    edges: [...merged.values()].sort((a, b) => b.weight - a.weight).slice(0, MAX_EDGES),
  });
}