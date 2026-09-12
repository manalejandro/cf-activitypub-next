import { getCloudflareContext, json } from "@/lib/cf";

// GET /api/v1/instance/peers — Mastodon-compatible list of federated domains.
export async function GET(): Promise<Response> {
  const { env } = getCloudflareContext();
  const rows = await env.DB
    .prepare(
      `SELECT domain FROM (
         SELECT domain FROM instances WHERE suspended = 0
         UNION
         SELECT DISTINCT domain FROM actors WHERE is_local = 0 AND domain != ''
       ) ORDER BY domain`
    )
    .all<{ domain: string }>();
  return json(rows.results.map((r) => r.domain));
}
