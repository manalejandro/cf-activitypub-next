import { type NextRequest } from "next/server";
import { getCloudflareContext, activityJson, notFound } from "@/lib/cf";
import { getActorByUsername } from "@/lib/db";
import { collectionIRI, featureAuthorizationIRI, getCollectionItemContext } from "@/lib/activitypub/collections";
import { DEFAULT_CONTEXT } from "@/lib/activitypub/vocab";

// GET /users/:username/feature_authorizations/:itemId — FEP-7aa9 authorization
// that lets a remote instance include this (local) account in a collection.
// Mastodon's VerifyFeaturedItemService requires the authorization to be served
// from the featured account's own host.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ username: string; itemId: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { username, itemId } = await params;
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  const actor = await getActorByUsername(env.DB, username, domain);
  if (!actor || !actor.isLocal || actor.suspended) return notFound("Actor not found");

  const ctx = await getCollectionItemContext(env.DB, itemId);
  if (!ctx || ctx.collection.account_id !== actor.id || ctx.item.state !== "accepted") {
    return notFound("Authorization not found");
  }
  // Only accounts we host can be authorized by us.
  if (!ctx.item.accountId.startsWith(`${baseUrl}/`)) return notFound("Authorization not found");

  return activityJson({
    "@context": DEFAULT_CONTEXT,
    id: featureAuthorizationIRI(baseUrl, actor.username, itemId),
    type: "FeatureAuthorization",
    attributedTo: ctx.item.accountId,
    interactingObject: collectionIRI(baseUrl, actor.username, ctx.collection.id),
    interactionTarget: ctx.item.accountId,
  });
}
