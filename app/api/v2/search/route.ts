import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorById, getActorsByIds, getAttachmentsByObjectIds, getAllCustomEmojis, searchCollections, getLastStatusAtMap , getBookmarkedObjectIds, getMutedActorIds, getActorFieldsMap } from "@/lib/db";
import { serializeAccount, serializeStatus, serializeCollection } from "@/lib/mastodon/serializers";
import { fetchAndCacheRemoteActor, fetchAndCacheRemoteStatus } from "@/lib/activitypub/remote";
import { validateOutboundUrl } from "@/lib/activitypub/federation";
import type { D1Database } from "@cloudflare/workers-types";
import { resolveLimits } from "@/lib/constants";
import { getFilterResultsForStatuses } from "@/lib/mastodon/filters";
import { getStatusAuthorExtras } from "@/lib/mastodon/account-extras";

// GET /api/v2/search?q=...&type=accounts|statuses|hashtags&limit=20&offset=0
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const domain = new URL(request.url).hostname;
  const sp = request.nextUrl.searchParams;

  const q = (sp.get("q") ?? "").trim();
  const type = sp.get("type") ?? "all";
  const limit = Math.min(parseInt(sp.get("limit") ?? String(limits.defaultTimelinePage)), limits.maxPageSize);
  const offset = parseInt(sp.get("offset") ?? "0");
  const resolve = sp.get("resolve") === "true";

  if (!q) return json({ accounts: [], statuses: [], hashtags: [], collections: [] });

  const me = await getAuthenticatedActor(request, env.DB);

  const results: {
    accounts: unknown[];
    statuses: unknown[];
    hashtags: { name: string; url: string; history: unknown[] }[];
    collections: unknown[];
  } = { accounts: [], statuses: [], hashtags: [], collections: [] };

  const doAccounts = type === "all" || type === "accounts";
  const doStatuses = type === "all" || type === "statuses";
  const doHashtags = type === "all" || type === "hashtags";
  const doCollections = type === "all" || type === "collections";

  // ── URL resolution ─────────────────────────────────────────────────────────
  // Pasting a federated account/status URL resolves it (local match first,
  // then fetched from the remote server) regardless of the `resolve` flag.
  const isUrl = /^https?:\/\/.+/i.test(q);
  if (isUrl) {
    const localObj = await env.DB.prepare("SELECT id FROM objects WHERE id = ? OR url = ?").bind(q, q).first<{ id: string }>();
    if (localObj) {
      const [rows, allEmojis] = await Promise.all([
        // `o.*` only: `SELECT o.*, a.*` would make duplicate columns (id,
        // updated_at…) resolve to the actor's values.
        env.DB.prepare("SELECT o.* FROM objects o JOIN actors a ON a.id = o.actor_id WHERE o.id = ?").bind(localObj.id).all<Record<string, unknown>>(),
        getAllCustomEmojis(env.DB),
      ]);
      const row = rows.results[0];
      // Only trust a cached row that actually has content; otherwise fall
      // through to the remote fetch, which repairs content-empty copies.
      if (row && row.content) {
        const actor = await getActorById(env.DB, row.actor_id as string);
        if (actor && !actor.suspended && !actor.silenced) {
          const obj = { id: row.id as string, type: row.type as string, actorId: row.actor_id as string, content: row.content as string, contentWarning: row.content_warning as string | null, sensitive: Boolean(row.sensitive), visibility: row.visibility as "public" | "unlisted" | "followers" | "direct", inReplyToId: row.in_reply_to_id as string | null, quoteId: (row.quote_id as string | null) ?? null, language: row.language as string | null, url: row.url as string, repliesCount: Number(row.replies_count ?? 0), reblogsCount: Number(row.reblogs_count ?? 0), favouritesCount: Number(row.favourites_count ?? 0), published: row.published as string, updatedAt: row.updated_at as string, local: Boolean(row.local), raw: row.raw as string };
          const attachments = await getAttachmentsByObjectIds(env.DB, [obj.id]);
          const filtered = me ? (await getFilterResultsForStatuses(env.DB, me.id, [obj])).get(obj.id) ?? [] : [];
          results.statuses.push(serializeStatus(obj, actor, domain, { attachments: attachments.get(obj.id) ?? [], favourited: false, reblogged: false, emojis: allEmojis, filtered }));
        }
        return json(results);
      }
    }

    // `actors` has no `url` column — its `id` is already the actor IRI.
    const localActor = await env.DB.prepare("SELECT id FROM actors WHERE id = ?").bind(q).first<{ id: string }>();
    if (localActor) {
      const actor = await getActorById(env.DB, localActor.id);
      if (actor && !actor.suspended && !actor.silenced) {
        results.accounts.push(serializeAccount(actor, domain));
      }
      return json(results);
    }

    // Remote: try a status URL, then an actor URL.
    const remoteStatus = await fetchAndCacheRemoteStatus(env.DB, q);
    if (remoteStatus.object && remoteStatus.actor) {
      const [allEmojis, attachments] = await Promise.all([
        getAllCustomEmojis(env.DB),
        getAttachmentsByObjectIds(env.DB, [remoteStatus.object.id]),
      ]);
      const filteredRemote = me ? (await getFilterResultsForStatuses(env.DB, me.id, [remoteStatus.object])).get(remoteStatus.object.id) ?? [] : [];
      const authorLastStatusAt = (await getLastStatusAtMap(env.DB, [remoteStatus.object.actorId])).get(remoteStatus.object.actorId) ?? null;
      const authorExtras = (await getStatusAuthorExtras(env.DB, [remoteStatus.object.actorId], domain)).get(remoteStatus.object.actorId);
      const bookmarked = me ? (await getBookmarkedObjectIds(env.DB, me.id, [remoteStatus.object.id])).has(remoteStatus.object.id) : false;
      const muted = me ? (await getMutedActorIds(env.DB, me.id)).includes(remoteStatus.object.actorId) : false;
      const authorFields = (await getActorFieldsMap(env.DB, [remoteStatus.object.actorId])).get(remoteStatus.object.actorId) ?? [];
      results.statuses.push(serializeStatus(remoteStatus.object, remoteStatus.actor, domain, { attachments: attachments.get(remoteStatus.object.id) ?? [], favourited: false, reblogged: false, emojis: allEmojis, filtered: filteredRemote, authorLastStatusAt, authorSupportsCalls: authorExtras?.supportsCalls, authorMoved: authorExtras?.moved ?? null, bookmarked, muted, authorFields }));
      return json(results);
    }
    const cachedActor = await fetchAndCacheRemoteActor(env.DB, q, env.KV);
    if (cachedActor) {
      const actor = await getActorById(env.DB, cachedActor.id);
      if (actor && !actor.suspended && !actor.silenced) {
        results.accounts.push(serializeAccount(actor, domain));
      }
    }
    return json(results);
  }

  // ── Accounts ─────────────────────────────────────────────────────────────
  if (doAccounts) {
    // If the query looks like @username@domain or username@domain, try resolving remotely
    const isFederated = q.includes("@") && !q.startsWith("#");
    if (isFederated && resolve) {
      const parts = q.replace(/^@/, "").split("@");
      const username = parts[0];
      const remoteDomain = parts[1];
      if (remoteDomain) {
        try {
          const webfingerUrl = `https://${remoteDomain}/.well-known/webfinger?resource=acct:${username}@${remoteDomain}`;
          const val = validateOutboundUrl(webfingerUrl);
          if (!val.valid) {
            return json({ accounts: [], statuses: [], hashtags: [], collections: [] });
          }
          const wfRes = await fetch(webfingerUrl, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(5000),
          });
          if (wfRes.ok) {
            const wf = await wfRes.json() as { links?: { rel: string; href: string }[] };
            const selfLink = wf.links?.find((l) => l.rel === "self");
            if (selfLink?.href) {
              const cached = await fetchAndCacheRemoteActor(env.DB, selfLink.href, env.KV);
              if (cached) {
                const actor = await getActorById(env.DB, cached.id);
                if (actor && !actor.suspended && !actor.silenced) {
                  results.accounts.push(serializeAccount(actor, domain));
                }
              }
            }
          }
        } catch { /* ignore network errors */ }
      }
    }

    // Search local actors
    const like = `%${q.replace(/[%_]/g, "\\$&")}%`;
    const rows = await env.DB
      .prepare(
        `SELECT * FROM actors WHERE (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\') AND is_local = 1 AND suspended = 0 AND silenced = 0 LIMIT ? OFFSET ?`
      )
      .bind(like, like, limit, offset)
      .all<Record<string, unknown>>();

    for (const row of rows.results) {
      const actor = await getActorById(env.DB, row.id as string);
      if (actor) results.accounts.push(serializeAccount(actor, domain));
    }
  }

  // ── Statuses ─────────────────────────────────────────────────────────────
  if (doStatuses && me) {
    const like = `%${q.replace(/[%_]/g, "\\$&")}%`;
    // Recency bound: LIKE cannot use an index, so an unbounded search scans the
    // whole objects table from newest to oldest until LIMIT rows match. The
    // 90-day bound (same as the hashtag timeline) caps that scan.
    const recencyBound = new Date(Date.now() - 90 * 86400000).toISOString();
    const rows = await env.DB
      .prepare(
        `SELECT o.* FROM objects o
         JOIN actors a ON a.id = o.actor_id
         WHERE o.content LIKE ? ESCAPE '\\'
           AND o.visibility IN ('public', 'unlisted')
           AND o.published >= ?
           AND a.suspended = 0 AND a.silenced = 0
         ORDER BY o.published DESC
         LIMIT ? OFFSET ?`
      )
      .bind(like, recencyBound, limit, offset)
      .all<Record<string, unknown>>();

    const objectIds = rows.results.map((r) => r.id as string);
    const objs = rows.results.map((r) => ({
      id: r.id as string,
      type: r.type as string,
      actorId: r.actor_id as string,
      content: r.content as string,
      contentWarning: r.content_warning as string | null,
      sensitive: Boolean(r.sensitive),
      visibility: r.visibility as "public" | "unlisted" | "followers" | "direct",
      inReplyToId: r.in_reply_to_id as string | null,
      quoteId: (r.quote_id as string | null) ?? null,
      language: r.language as string | null,
      url: r.url as string,
      repliesCount: Number(r.replies_count ?? 0),
      reblogsCount: Number(r.reblogs_count ?? 0),
      favouritesCount: Number(r.favourites_count ?? 0),
      published: r.published as string,
      updatedAt: r.updated_at as string,
      local: Boolean(r.is_local),
      raw: r.raw as string,
    }));

    // Batch everything once instead of N per-status round-trips (the old loop
    // also re-fetched the viewer's mute list once per result row).
    const actorIds = [...new Set(objs.map((o) => o.actorId))];
    const [attachmentMap, allEmojis, authorMap, lastStatusAtMap, authorExtrasMap, authorFieldsMap, filteredMap, bookmarkedIds, mutedIds] = await Promise.all([
      objectIds.length > 0 ? getAttachmentsByObjectIds(env.DB, objectIds) : Promise.resolve(new Map()),
      getAllCustomEmojis(env.DB),
      getActorsByIds(env.DB, actorIds),
      getLastStatusAtMap(env.DB, actorIds),
      getStatusAuthorExtras(env.DB, actorIds, domain),
      getActorFieldsMap(env.DB, actorIds),
      me ? getFilterResultsForStatuses(env.DB, me.id, objs) : Promise.resolve(new Map()),
      me ? getBookmarkedObjectIds(env.DB, me.id, objectIds) : Promise.resolve(new Set()),
      me ? getMutedActorIds(env.DB, me.id) : Promise.resolve([]),
    ]);

    for (const obj of objs) {
      const actor = authorMap.get(obj.actorId) ?? null;
      if (!actor) continue;
      const mutedSet = new Set(mutedIds);
      results.statuses.push(
        serializeStatus(obj, actor, domain, {
          attachments: attachmentMap.get(obj.id) ?? [],
          favourited: false,
          reblogged: false,
          emojis: allEmojis,
          filtered: filteredMap.get(obj.id) ?? [],
          authorLastStatusAt: lastStatusAtMap.get(obj.actorId) ?? null,
          authorSupportsCalls: authorExtrasMap.get(obj.actorId)?.supportsCalls,
          authorMoved: authorExtrasMap.get(obj.actorId)?.moved ?? null,
          bookmarked: bookmarkedIds.has(obj.id),
          muted: mutedSet.has(obj.actorId),
          authorFields: authorFieldsMap.get(obj.actorId) ?? [],
        })
      );
    }
  }

  // ── Hashtags ──────────────────────────────────────────────────────────────
  if (doHashtags) {
    // Tag discovery + ranking comes from the object_tags index (extracted at
    // ingest) instead of a LIKE scan over every stored content/raw document,
    // which was the single most expensive query on the instance.
    const tagQuery = (q.startsWith("#") ? q.slice(1) : q).toLowerCase();
    const tagLike = `%${tagQuery.replace(/[%_]/g, "\\$&")}%`;
    const tagCutoff = new Date(Date.now() - 90 * 86400000).toISOString();
    const tagRows = await env.DB
      .prepare(
        `SELECT tag, COUNT(*) AS uses
         FROM object_tags
         WHERE tag LIKE ? ESCAPE '\\'
           AND published >= ?
         GROUP BY tag
         ORDER BY uses DESC
         LIMIT 200`
      )
      .bind(tagLike, tagCutoff)
      .all<{ tag: string; uses: number }>();

    const sorted = tagRows.results
      .slice(offset, offset + limit)
      .map((r) => ({ name: r.tag, uses: r.uses }));

    results.hashtags = await Promise.all(
      sorted.map(async ({ name }) => ({
        name,
        url: `https://${domain}/tags/${name}`,
        history: await getTagHistory(env.DB, name),
      }))
    );
  }

  // ── Collections ───────────────────────────────────────────────────────────
  if (doCollections) {
    const collections = await searchCollections(env.DB, q, { limit, offset });
    for (const col of collections) {
      results.collections.push(serializeCollection(col, domain));
    }
  }

  return json(results);
}

async function getTagHistory(
  db: D1Database,
  tagName: string
): Promise<{ day: string; uses: string; accounts: string }[]> {
  // Bind the cutoff as ISO: `published` is stored ISO-8601, so comparing it
  // against datetime('now', ...) (space format) breaks the lexical comparison.
  const weekCutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  // Fully index-only via the (tag, published, actor_id) covering index: no
  // join back to objects, no JSON parsing, no row reads.
  const rows = await db
    .prepare(
      `SELECT CAST(strftime('%s', published) / 86400 AS INTEGER) AS day_bucket,
              COUNT(*) AS uses,
              COUNT(DISTINCT actor_id) AS accounts
       FROM object_tags
       WHERE tag = ?
         AND published >= ?
       GROUP BY day_bucket
       ORDER BY day_bucket`
    )
    .bind(tagName, weekCutoff)
    .all<{ day_bucket: number; uses: number; accounts: number }>();

  const byDay = new Map<number, { uses: number; accounts: number }>();
  for (const r of rows.results) {
    byDay.set(r.day_bucket, { uses: Number(r.uses), accounts: Number(r.accounts) });
  }

  const now = new Date();
  const history: { day: string; uses: string; accounts: string }[] = [];
  for (let i = 0; i <= 6; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    const dayBucket = Math.floor(d.getTime() / 1000 / 86400);
    const dayStart = Math.floor(d.getTime() / 1000);
    const stats = byDay.get(dayBucket);
    history.push({
      day: String(dayStart),
      uses: String(stats?.uses ?? 0),
      accounts: String(stats?.accounts ?? 0),
    });
  }
  return history;
}