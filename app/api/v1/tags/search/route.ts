import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { resolveLimits } from "@/lib/constants";
import { serializeTag } from "@/lib/mastodon/tags";

// GET /api/v1/tags/search?q=...&limit=...
//
// Mastodon-compatible hashtag autocomplete: prefix matches over the
// `object_tags` index (extracted at ingest), most used first. Anonymous
// callers get the same results as trending tags (tag names are public).
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const url = new URL(request.url);
  const domain = url.hostname;
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const limit = Math.min(
    parseInt(url.searchParams.get("limit") ?? "6") || 6,
    limits.maxPageSize
  );

  // The client sends what was typed after `#`; tolerate a leading `#` too.
  const query = (url.searchParams.get("q") ?? "").trim().replace(/^#+/, "").toLowerCase();
  if (!query) return json([]);

  const escapeLike = (s: string) => s.replace(/[%_\\]/g, "\\$&");
  // Prefix only: the (tag, published) index can serve it (leading-% scans were
  // the instance's most expensive query pattern). Autocomplete is prefix-based
  // in Mastodon too.
  const prefix = `${escapeLike(query)}%`;
  // Same recency bound as the hashtag timeline: dead tags from years ago are
  // not useful suggestions.
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();

  const rows = await env.DB
    .prepare(
      `SELECT tag, COUNT(*) AS uses, COUNT(DISTINCT actor_id) AS actors
       FROM object_tags
       WHERE tag LIKE ? ESCAPE '\\'
         AND published >= ?
       GROUP BY tag
       ORDER BY uses DESC
       LIMIT ?`
    )
    .bind(prefix, cutoff, limit)
    .all<{ tag: string; uses: number; actors: number }>();

  return json(
    (rows.results ?? []).map((row) =>
      serializeTag(row.tag, domain, Number(row.uses ?? 0), Number(row.actors ?? 0))
    )
  );
}
