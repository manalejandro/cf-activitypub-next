import { type NextRequest } from "next/server";
import { notFound } from "@/lib/cf";
import { getObjectById } from "@/lib/db";
import { DEFAULT_CONTEXT } from "@/lib/activitypub/vocab";
import { objectIRI } from "@/lib/activitypub/utils";
import { env } from "cloudflare:workers";

/** Mastodon's replies page size (`ActivityPub::RepliesController::DESCENDANTS_LIMIT`). */
const REPLIES_LIMIT = 60;

/**
 * GET /objects/:id/likes|shares|replies — Mastodon's status collections
 * (`ActivityPub::LikesController`/`SharesController`/`RepliesController`).
 *
 * The note advertises these URLs; serving them keeps the links alive and lets
 * peers backfill a thread (`FetchRepliesService` follows the `replies`
 * collection). Likes/shares only expose their counts, like Mastodon; replies
 * return the reply IRIs (oldest first, cursor-paginated with `min_id`).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; collection: string }> }
): Promise<Response> {
  const { id, collection } = await params;
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  const objectId = objectIRI(baseUrl, id);
  const obj = await getObjectById(env.DB, objectId);
  // Only local, publicly distributable statuses expose their collections.
  if (!obj || !obj.local) return notFound("Object not found");
  if (obj.visibility !== "public" && obj.visibility !== "unlisted") return notFound("Object not found");

  const collectionId = `${objectId}/${collection}`;
  const headers = { "Content-Type": "application/activity+json; charset=utf-8" };

  if (collection === "likes" || collection === "shares") {
    return new Response(
      JSON.stringify({
        "@context": DEFAULT_CONTEXT,
        id: collectionId,
        type: "Collection",
        totalItems: collection === "likes" ? obj.favouritesCount : obj.reblogsCount,
      }),
      { headers }
    );
  }

  if (collection !== "replies") return notFound("Object not found");

  const pageRequested = request.nextUrl.searchParams.get("page") === "true";
  const minId = request.nextUrl.searchParams.get("min_id");

  const rows = await env.DB
    .prepare(
      `SELECT o.id FROM objects o
       WHERE o.in_reply_to_id = ? AND o.media_pending = 0
         AND o.visibility IN ('public', 'unlisted')
         AND (? IS NULL OR o.published > (SELECT published FROM objects WHERE id = ?))
       ORDER BY o.published ASC LIMIT ?`
    )
    .bind(objectId, minId, minId, REPLIES_LIMIT + 1)
    .all<{ id: string }>();

  const all = rows.results.map((row) => row.id);
  const items = all.slice(0, REPLIES_LIMIT);
  const next = all.length > REPLIES_LIMIT && items.length > 0
    ? `${collectionId}?page=true&min_id=${encodeURIComponent(items[items.length - 1])}`
    : undefined;

  const page = {
    id: pageRequested ? `${collectionId}?page=true${minId ? `&min_id=${encodeURIComponent(minId)}` : ""}` : `${collectionId}?page=true`,
    type: "CollectionPage",
    partOf: collectionId,
    orderedItems: items,
    ...(next ? { next } : {}),
  };

  const body = pageRequested
    ? { "@context": DEFAULT_CONTEXT, ...page }
    : {
        "@context": DEFAULT_CONTEXT,
        id: collectionId,
        type: "Collection",
        first: { ...page, id: `${collectionId}?page=true` },
      };

  return new Response(JSON.stringify(body), { headers });
}
