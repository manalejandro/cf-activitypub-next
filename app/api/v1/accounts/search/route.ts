import { type NextRequest } from "next/server";
import { json } from "@/lib/cf";
import { getActorById, getActorByUsername, getAllCustomEmojis, getLastStatusAt } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { clampLimit, resolveLimits } from "@/lib/constants";
import { parseAccountQuery } from "@/lib/account-search";
import { resolveWebFinger } from "@/lib/activitypub/federation";
import { fetchAndCacheRemoteActor } from "@/lib/activitypub/remote";
import { env } from "cloudflare:workers";

// GET /api/v1/accounts/search — account autocomplete/search.
//
// Accepts a plain username (prefix match), a display-name substring, a handle
// (`@user@domain`, with or without the leading `@`) and a pasted profile URL
// (`https://domain/@user`, `https://domain/users/user`). A handle or URL is
// resolved to the account itself first — Mastodon's `AccountSearchService` plus
// `ResolveURLService` — and with `resolve=true` an authenticated caller gets an
// uncached remote account fetched and cached.
export async function GET(request: NextRequest): Promise<Response> {
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const domain = new URL(request.url).hostname;
  const query = parseAccountQuery(request.nextUrl.searchParams.get("q") ?? "");
  const limit = clampLimit(request.nextUrl.searchParams.get("limit"), limits.defaultTimelinePage, limits.maxPageSize);
  if (!query.text) return json([]);

  // Cached remote accounts are only exposed to authenticated callers (same
  // policy as lookup / :id / :id/statuses).
  const me = await getAuthenticatedActor(request, env.DB);
  const emojis = await getAllCustomEmojis(env.DB);
  const results: ReturnType<typeof serializeAccount>[] = [];
  const seen = new Set<string>();

  const push = async (actorId: string): Promise<void> => {
    if (seen.has(actorId)) return;
    const actor = await getActorById(env.DB, actorId);
    // Limited (silenced) accounts stay resolvable: Mastodon's `Account.searchable`
    // only excludes suspended and moved accounts — a limited account can still
    // be found, mentioned and followed.
    if (!actor || actor.suspended) return;
    if (!actor.isLocal && !me) return;
    seen.add(actorId);
    results.push(
      serializeAccount(actor, domain, {
        emojis,
        lastStatusAt: await getLastStatusAt(env.DB, actor.id),
      })
    );
  };

  // An exact handle (or a pasted profile URL) names one account: resolve it
  // before falling back to the text search.
  if (query.username && query.domain) {
    const localDomain = domain.toLowerCase();
    const isLocalDomain = query.domain === localDomain;
    let actor = await getActorByUsername(env.DB, query.username, isLocalDomain ? domain : query.domain);
    if (!actor && !isLocalDomain && me && request.nextUrl.searchParams.get("resolve") === "true") {
      try {
        const resolvedUrl = await resolveWebFinger(`${query.username}@${query.domain}`);
        if (resolvedUrl) {
          const cached = await fetchAndCacheRemoteActor(env.DB, resolvedUrl, env.KV);
          if (cached) actor = await getActorById(env.DB, cached.id);
        }
      } catch { /* fall through to the text search */ }
    }
    if (actor) await push(actor.id);
  }

  // Prefix match on username (autocomplete), substring on display name; a
  // handle also matches username + domain. Local accounts rank first, then
  // cached remote ones by popularity. Suspended accounts are never suggested.
  const escapeLike = (s: string) => s.replace(/[%_\\]/g, "\\$&");
  const likeUsername = `${escapeLike(query.text)}%`;
  const likeDisplay = `%${escapeLike(query.text)}%`;
  let sql = `SELECT id FROM actors WHERE suspended = 0${me ? "" : " AND is_local = 1"} AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')`;
  const params: string[] = [likeUsername, likeDisplay];
  if (query.username && query.domain) {
    sql += ` OR (username LIKE ? ESCAPE '\\' AND domain LIKE ? ESCAPE '\\')`;
    params.push(`${escapeLike(query.username)}%`, `${escapeLike(query.domain)}%`);
  }
  sql += ` ORDER BY is_local DESC, followers_count DESC LIMIT ?`;
  params.push(String(limit));

  const rows = await env.DB
    .prepare(sql)
    .bind(...params)
    .all<{ id: string }>();
  for (const row of rows.results ?? []) {
    await push(row.id);
  }

  return json(results.slice(0, limit));
}
