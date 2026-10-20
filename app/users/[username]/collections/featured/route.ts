import { type NextRequest } from "next/server";
import { activityJson, getBaseUrl, notFound } from "@/lib/cf";
import { getActorByUsername } from "@/lib/db";
import { DEFAULT_CONTEXT } from "@/lib/activitypub/vocab";
import { env } from "cloudflare:workers";

// GET /users/:username/collections/featured — the account's pinned statuses.
// Mastodon advertises this URL as the actor's `featured` and sends it as the
// `target` of every `Add`/`Remove` when a status is pinned or unpinned; peers
// fetch it on demand to render a remote profile's pinned posts
// (ActivityPub::CollectionsController#show + CollectionSerializer: an
// OrderedCollection whose items are status URIs).
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> }
): Promise<Response> {
  const { username } = await params;
  const domain = new URL(request.url).hostname;
  // The collection id must match what the actor document advertises
  // (buildActor builds it from the canonical instance URL, never the Host).
  const baseUrl = getBaseUrl(env);

  const actor = await getActorByUsername(env.DB, username, domain);
  // Only local accounts serve it, and a suspended one serves nothing (its
  // content is "removed publicly").
  if (!actor || !actor.isLocal || actor.suspended) return notFound("Actor not found");

  const rows = await env.DB
    .prepare(
      `SELECT o.id FROM status_pins sp
         JOIN objects o ON o.id = sp.status_id
        WHERE sp.actor_id = ? AND o.visibility IN ('public', 'unlisted')
        ORDER BY sp.created_at DESC`
    )
    .bind(actor.id)
    .all<{ id: string }>();
  const items = (rows.results ?? []).map((row) => row.id);

  return activityJson(
    {
      "@context": DEFAULT_CONTEXT,
      id: `${baseUrl}/users/${actor.username}/collections/featured`,
      type: "OrderedCollection",
      totalItems: items.length,
      orderedItems: items,
    },
    200,
    // Mastodon expires the collection after 3 minutes.
    { "Cache-Control": "public, max-age=180" }
  );
}
