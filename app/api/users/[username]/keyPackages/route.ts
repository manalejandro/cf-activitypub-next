import { type NextRequest } from "next/server";
import { getCloudflareContext, activityJson, notFound } from "@/lib/cf";
import { getActorByUsername, getMlsKeyPackagesByActor } from "@/lib/db";
import { actorIRI } from "@/lib/activitypub/utils";
import { DEFAULT_CONTEXT } from "@/lib/activitypub/vocab";
import type { LocalMlsKeyPackage } from "@/lib/types";

// GET /users/:username/keyPackages
//
// KeyPackages collection (MLS over ActivityPub draft). Returns active RFC 9420
// key packages as KeyPackage objects; callers pick one to encrypt a Welcome or
// a PrivateMessage to this actor. Never returns decrypted material.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { username } = await params;
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  // Remote peers fetch key packages when encrypting to this actor; cache in KV
  // so a burst of encryption attempts doesn't hammer D1. Short TTL: a rotated
  // key package should become visible quickly.
  const cacheKey = `mls:keypackages:${username.toLowerCase()}`;
  const cached = await env.KV.get(cacheKey).catch(() => null);
  if (cached) {
    return activityJson(JSON.parse(cached) as Record<string, unknown>);
  }

  const actor = await getActorByUsername(env.DB, username, domain);
  if (!actor || !actor.isLocal) return notFound("Actor not found");

  const collectionId = `${actorIRI(baseUrl, username)}/keyPackages`;
  const keyPackages = await getMlsKeyPackagesByActor(env.DB, actor.id);

  // The draft allows a full Collection here; a page view returns just the items.
  const response = request.nextUrl.searchParams.get("page")
    ? {
        "@context": DEFAULT_CONTEXT,
        id: `${collectionId}?page=true`,
        type: "CollectionPage",
        partOf: collectionId,
        items: keyPackages.map((kp) => mlsKeyPackageObject(baseUrl, kp)),
      }
    : {
        "@context": DEFAULT_CONTEXT,
        id: collectionId,
        type: "Collection",
        totalItems: keyPackages.length,
        first: `${collectionId}?page=true`,
      };

  await env.KV.put(cacheKey, JSON.stringify(response), { expirationTtl: 60 }).catch(() => {});
  return activityJson(response);
}

function mlsKeyPackageObject(baseUrl: string, kp: LocalMlsKeyPackage): Record<string, unknown> {
  return {
    "@context": DEFAULT_CONTEXT,
    id: kp.objectId,
    type: "KeyPackage",
    ciphersuite: kp.ciphersuite ?? undefined,
    mediaType: kp.mediaType ?? "message/mls",
    encoding: kp.encoding ?? undefined,
    content: kp.content ?? undefined,
  };
}