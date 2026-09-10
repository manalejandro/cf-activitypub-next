import { type NextRequest } from "next/server";
import { getCloudflareContext, activityJson, notFound, unauthorized } from "@/lib/cf";
import { getActorByUsername, getMlsMessagesByRecipient, countMlsMessagesByRecipient } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { resolveLimits } from "@/lib/constants";
import { actorIRI } from "@/lib/activitypub/utils";
import { DEFAULT_CONTEXT } from "@/lib/activitypub/vocab";

// GET /users/:username/messages
//
// OrderedCollection of the MLS activities (Create/Add/Remove/Delete) delivered
// to this actor. Items are the raw ActivityPub activities whose object carries
// an encrypted MLSTM envelope — the server cannot decrypt them.
// The collection carries private ciphertext and sender/conversation metadata,
// so only its own actor (authenticated) may read it.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { username } = await params;
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  const actor = await getActorByUsername(env.DB, username, domain);
  if (!actor || !actor.isLocal) return notFound("Actor not found");

  const me = await getAuthenticatedActor(request, env.DB);
  if (!me || me.id !== actor.id) return unauthorized();

  const collectionId = `${actorIRI(baseUrl, username)}/messages`;
  const page = request.nextUrl.searchParams.get("page");

  if (!page) {
    const total = await countMlsMessagesByRecipient(env.DB, actor.id);
    return activityJson({
      "@context": DEFAULT_CONTEXT,
      id: collectionId,
      type: "OrderedCollection",
      totalItems: total,
      first: `${collectionId}?page=true`,
    });
  }

  const limit = resolveLimits(env as unknown as Record<string, unknown>).mlsMessagesPageSize;
  const maxId = request.nextUrl.searchParams.get("max_id") ?? undefined;
  const messages = await getMlsMessagesByRecipient(env.DB, actor.id, limit, maxId);
  const items = messages.map((m) => JSON.parse(m.raw));
  const nextId =
    messages.length === limit
      ? `${collectionId}?page=true&max_id=${encodeURIComponent(messages[messages.length - 1].id)}`
      : undefined;

  const pageDoc: Record<string, unknown> = {
    "@context": DEFAULT_CONTEXT,
    id: `${collectionId}?page=true`,
    type: "OrderedCollectionPage",
    partOf: collectionId,
    orderedItems: items,
  };
  if (nextId) pageDoc.next = nextId;
  return activityJson(pageDoc);
}
