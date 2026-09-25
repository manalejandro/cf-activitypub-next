import { getCloudflareContext, json, getBaseUrl, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorById, getMlsKeyPackagesByActor } from "@/lib/db";
import { safeFetch, signedGetHeaders, validateOutboundUrl } from "@/lib/activitypub/federation";
import type { NextRequest } from "next/server";

// GET /api/v1/e2ee/keypackage?iri=<actorIri>
//
// Returns the recipient's latest active KeyPackage (as the MLS draft keyPackages
// collection would) so the client can encrypt a message to its init_key. The
// server never sees the plaintext — it only hands out the public key package.

export async function GET(request: NextRequest): Promise<Response> {
  const iri = (request.nextUrl.searchParams.get("iri") ?? "").trim();
  if (!iri) return json({ error: "iri parameter required" }, 422);

  const { env } = getCloudflareContext();
  // Resolving remote key packages triggers outbound fetches — require a session.
  const me = await getAuthenticatedActor(request, env.DB);
  if (!me) return unauthorized();
  const baseUrl = getBaseUrl(env);

  // Local actor → read its keyPackages collection from the database.
  if (iri.startsWith(baseUrl + "/")) {
    const actor = await getActorById(env.DB, iri);
    if (!actor) return json({ error: "Actor not found" }, 404);
    const kps = await getMlsKeyPackagesByActor(env.DB, actor.id, true);
    const kp = kps[0];
    if (!kp) return json({ error: "No active key package for this actor" }, 404);
    return json({
      objectId: kp.objectId,
      ciphersuite: kp.ciphersuite,
      mediaType: kp.mediaType,
      encoding: kp.encoding,
      content: kp.content,
    });
  }

  // Remote actor → fetch its key packages, trying in order:
  //   1. the remote instance's own /api/v1/e2ee/keypackage endpoint (this
  //      software serves its local actors' public key material without auth),
  //   2. the draft `${iri}/keyPackages` collection,
  //   3. the actor document's advertised keyPackages relation.
  const headers = { Accept: "application/activity+json, application/ld+json, application/json" };
  try {
    const val = validateOutboundUrl(iri);
    if (!val.valid) return json({ error: "Invalid IRI" }, 422);
    const origin = new URL(iri).origin;

    // 1. Remote instance's own keypackage endpoint (same-software federation).
    const apiRes = await fetchWithTimeout(
      `${origin}/api/v1/e2ee/keypackage?iri=${encodeURIComponent(iri)}`,
      { Accept: "application/json" }
    );
    if (apiRes?.ok) {
      const parsed = (await apiRes.json()) as {
        objectId?: string | null;
        ciphersuite?: string | null;
        mediaType?: string | null;
        encoding?: string | null;
        content?: string;
      };
      if (typeof parsed.content === "string") {
        return json({
          objectId: parsed.objectId ?? null,
          ciphersuite: parsed.ciphersuite ?? null,
          mediaType: parsed.mediaType ?? "message/mls",
          encoding: parsed.encoding ?? "base64",
          content: parsed.content,
        });
      }
    }

    // 2. Draft keyPackages collection.
    const kpRes = await fetchWithTimeout(`${iri.replace(/\/$/, "")}/keyPackages?page=true`, headers);
    if (kpRes?.ok) {
      const found = await parseKeyPackageCollection(kpRes);
      if (found) return found;
    }

    // 3. Actor document's advertised keyPackages relation.
    const actorRes = await fetchWithTimeout(iri, headers);
    if (actorRes?.ok) {
      const actor = (await actorRes.json()) as { keyPackages?: unknown } | null;
      const kpRel = actor?.keyPackages;
      if (kpRel && typeof kpRel === "object" && (kpRel as { content?: string }).content) {
        // Single KeyPackage object, no collection request needed.
        const direct = kpRel as { id?: string; content: string };
        return keyPackageJson({ objectId: direct.id ?? null, ciphersuite: null, mediaType: "message/mls", encoding: "base64", content: direct.content });
      }
      let relUrl = typeof kpRel === "string" ? kpRel : (kpRel as { id?: string } | null)?.id;
      if (relUrl) {
        const val = validateOutboundUrl(relUrl);
        if (val.valid) {
          relUrl = `${relUrl.replace(/\/$/, "")}?page=true`;
          const relRes = await fetchWithTimeout(relUrl, headers);
          if (relRes?.ok) {
            const found = await parseKeyPackageCollection(relRes);
            if (found) return found;
          }
        }
      }
    }
    return json({ error: "Remote actor does not expose keyPackages (its /keyPackages collection returned no data). Update the remote instance." }, 404);
  } catch {
    return json({ error: "Could not fetch remote keyPackages" }, 502);
  }
}

async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response | null> {
  // safeFetch re-validates every redirect hop (SSRF) and bounds the exchange.
  // Signed GET: authorized-fetch instances reject unsigned AP requests.
  return await safeFetch(url, { headers: { ...headers, ...(await signedGetHeaders(url)) } }, 6000);
}

async function parseKeyPackageCollection(res: Response): Promise<Response | null> {
  const body = (await res.json()) as {
    items?: unknown;
    orderedItems?: unknown;
    // Some servers return the single KeyPackage object instead of a collection.
    content?: string;
    id?: string;
  } | null;
  const itemWithContent = (list: unknown): { content: string; id?: string } | null => {
    const arr = Array.isArray(list) ? list : list && typeof list === "object" ? [list] : null;
    for (const entry of arr ?? []) {
      if (entry && typeof entry === "object" && (entry as { content?: unknown }).content) {
        return entry as { content: string; id?: string };
      }
    }
    return null;
  };
  const item = body ? itemWithContent(body.items) ?? itemWithContent(body.orderedItems) ?? (body.content ? body : null) : null;
  if (!item?.content) return null;
  return keyPackageJson({ objectId: item.id ?? null, ciphersuite: null, mediaType: "message/mls", encoding: "base64", content: item.content });
}

function keyPackageJson(kp: { objectId: string | null; ciphersuite: null; mediaType: string; encoding: string; content: string }): Response {
  return json(kp);
}