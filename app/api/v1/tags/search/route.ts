import { type NextRequest } from "next/server";
import { json } from "@/lib/cf";
import { resolveLimits } from "@/lib/constants";
import { serializeTag } from "@/lib/mastodon/tags";
import { env } from "cloudflare:workers";

// GET /api/v1/tags/search?q=...&limit=...
//
// Mastodon-compatible hashtag autocomplete: prefix matches over the
// `object_tags` index (extracted at ingest), most used first. Anonymous
// callers get the same results as trending tags (tag names are public).
export async function GET(request: NextRequest): Promise<Response> {
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

  // Prefix only, and GLOB's own wildcards are stripped from what the user
  // typed: the pattern must stay a plain prefix so it becomes an index range.
  const prefix = query.replace(/[*?[\]]/g, "");
  // Same recency bound as the hashtag timeline: dead tags from years ago are
  // not useful suggestions.
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();

  // Tags are stored lowercased, and GLOB is case-sensitive: it turns the
  // prefix into an index range on (tag, published, actor_id) — the LIKE it
  // replaces cannot use the index (SQLite's LIKE is case-insensitive) and
  // scanned the whole table, 800k rows per call in production.
  const tagPrefix = prefix.replace(/[*?[\]]/g, "").toLowerCase();
  const rows = await env.DB
    .prepare(
      `SELECT tag, COUNT(*) AS uses, COUNT(DISTINCT actor_id) AS actors
       FROM object_tags
       WHERE tag GLOB ? AND published >= ?
       GROUP BY tag
       ORDER BY uses DESC
       LIMIT ?`
    )
    .bind(`${tagPrefix}*`, cutoff, limit)
    .all<{ tag: string; uses: number; actors: number }>();

  return json(
    (rows.results ?? []).map((row) =>
      serializeTag(row.tag, domain, Number(row.uses ?? 0), Number(row.actors ?? 0))
    )
  );
}
