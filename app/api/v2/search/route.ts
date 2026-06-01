import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorById, getAttachmentsByObjectIds } from "@/lib/db";
import { serializeAccount, serializeStatus } from "@/lib/mastodon/serializers";
import { fetchAndCacheRemoteActor } from "@/lib/activitypub/remote";

// GET /api/v2/search?q=...&type=accounts|statuses|hashtags&limit=20&offset=0
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const sp = request.nextUrl.searchParams;

  const q = (sp.get("q") ?? "").trim();
  const type = sp.get("type") ?? "all";
  const limit = Math.min(parseInt(sp.get("limit") ?? "20"), 40);
  const offset = parseInt(sp.get("offset") ?? "0");
  const resolve = sp.get("resolve") === "true";

  if (!q) return json({ accounts: [], statuses: [], hashtags: [] });

  const me = await getAuthenticatedActor(request, env.DB);

  const results: {
    accounts: unknown[];
    statuses: unknown[];
    hashtags: { name: string; url: string; history: unknown[] }[];
  } = { accounts: [], statuses: [], hashtags: [] };

  const doAccounts = type === "all" || type === "accounts";
  const doStatuses = type === "all" || type === "statuses";
  const doHashtags = type === "all" || type === "hashtags";

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
          const wfRes = await fetch(webfingerUrl, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(5000),
          });
          if (wfRes.ok) {
            const wf = await wfRes.json() as { links?: { rel: string; href: string }[] };
            const selfLink = wf.links?.find((l) => l.rel === "self");
            if (selfLink?.href) {
              // Fetch the full actor profile and cache it in D1 so subsequent
              // operations (follow, view profile, etc.) don't need another round-trip.
              const cached = await fetchAndCacheRemoteActor(env.DB, selfLink.href);
              if (cached) {
                const actor = await getActorById(env.DB, cached.id);
                if (actor) {
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
        `SELECT * FROM actors WHERE (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\') AND is_local = 1 LIMIT ? OFFSET ?`
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
    const rows = await env.DB
      .prepare(
        `SELECT o.*, a.* FROM objects o
         JOIN actors a ON a.id = o.actor_id
         WHERE o.content LIKE ? ESCAPE '\\'
           AND o.visibility IN ('public', 'unlisted')
         ORDER BY o.published DESC
         LIMIT ? OFFSET ?`
      )
      .bind(like, limit, offset)
      .all<Record<string, unknown>>();

    // Group by objectId to batch-load attachments
    const objectIds = rows.results.map((r) => r.id as string);
    const attachmentMap = objectIds.length > 0
      ? await getAttachmentsByObjectIds(env.DB, objectIds)
      : new Map();

    for (const row of rows.results) {
      const actor = await getActorById(env.DB, row.actor_id as string);
      if (!actor) continue;
      const obj = {
        id: row.id as string,
        type: row.type as string,
        actorId: row.actor_id as string,
        content: row.content as string,
        contentWarning: row.content_warning as string | null,
        sensitive: Boolean(row.sensitive),
        visibility: row.visibility as "public" | "unlisted" | "followers" | "direct",
        inReplyToId: row.in_reply_to_id as string | null,
        language: row.language as string | null,
        url: row.url as string,
        repliesCount: Number(row.replies_count ?? 0),
        reblogsCount: Number(row.reblogs_count ?? 0),
        favouritesCount: Number(row.favourites_count ?? 0),
        published: row.published as string,
        updatedAt: row.updated_at as string,
        local: Boolean(row.local),
        raw: row.raw as string,
      };
      results.statuses.push(
        serializeStatus(obj, actor, domain, {
          attachments: attachmentMap.get(obj.id) ?? [],
          favourited: false,
          reblogged: false,
        })
      );
    }
  }

  // ── Hashtags ──────────────────────────────────────────────────────────────
  if (doHashtags) {
    const tagQuery = q.startsWith("#") ? q.slice(1) : q;
    const contentLike = `%#${tagQuery.replace(/[%_]/g, "\\$&")}%`;
    // Also match against the raw AP JSON where Mastodon stores tags as
    // {"type":"Hashtag","name":"#tag"} — catches posts where HTML uses
    // #<span>tag</span> which breaks the content LIKE pattern.
    const rawLike = `%"#${tagQuery.replace(/[%_]/g, "\\$&")}%`;
    const contentRows = await env.DB
      .prepare(
        `SELECT content, raw FROM objects
         WHERE (content LIKE ? ESCAPE '\\' OR raw LIKE ? ESCAPE '\\')
           AND visibility IN ('public', 'unlisted')
         LIMIT 200`
      )
      .bind(contentLike, rawLike)
      .all<{ content: string; raw: string }>();

    const tagCounts = new Map<string, number>();
    for (const { content, raw } of contentRows.results) {
      const names = new Set<string>();
      // Extract from HTML content (local posts: <a class="tag">#tag</a>)
      for (const m of content.match(/#([a-zA-Z0-9_]+)/g) ?? []) {
        names.add(m.slice(1).toLowerCase());
      }
      // Extract from raw AP JSON tag array (handles all servers)
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const tagArr = Array.isArray(parsed.tag) ? parsed.tag as unknown[] : (parsed.tag ? [parsed.tag] : []);
          for (const t of tagArr) {
            const tagObj = t as Record<string, unknown>;
            if (tagObj.type === "Hashtag" && typeof tagObj.name === "string") {
              const n = (tagObj.name.startsWith("#") ? tagObj.name.slice(1) : tagObj.name).toLowerCase();
              names.add(n);
            }
          }
        } catch { /* ignore malformed JSON */ }
      }
      for (const name of names) {
        if (name.includes(tagQuery.toLowerCase())) {
          tagCounts.set(name, (tagCounts.get(name) ?? 0) + 1);
        }
      }
    }
    const sorted = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(offset, offset + limit);

    results.hashtags = sorted.map(([name]) => ({
      name,
      url: `https://${domain}/tags/${name}`,
      history: [],
    }));
  }

  return json(results);
}
