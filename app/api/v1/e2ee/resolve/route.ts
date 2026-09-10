import { getBaseUrl, json, getCloudflareContext, unauthorized } from "@/lib/cf";
import { getActorByUsername, getActorById } from "@/lib/db";
import { fetchAndCacheRemoteActor } from "@/lib/activitypub/remote";
import { validateOutboundUrl } from "@/lib/activitypub/federation";
import { getAuthenticatedActor } from "@/lib/auth";
import type { D1Database } from "@cloudflare/workers-types";
import type { NextRequest } from "next/server";

// GET /api/v1/e2ee/resolve?handle=<handle>
//
// Resolves a recipient to its ActivityPub actor IRI(s) so the client can build
// an outbox Create(MLS message). Accepts:
//   - "alice"            → local user
//   - "alice@other.host" → remote user (WebFinger)
//   - "https://…/users/x" → passed through as-is
const WELL_KNOWN_HANDLES = /^https?:\/\//;

export async function GET(request: NextRequest): Promise<Response> {
  const handle = (request.nextUrl.searchParams.get("handle") ?? "").replace(/^@/, "").trim();
  if (!handle) return json({ error: "handle parameter required" }, 422);

  const { env } = getCloudflareContext();
  // Resolving recipients (WebFinger + remote actor fetch) is authenticated-only.
  const me = await getAuthenticatedActor(request, env.DB);
  if (!me) return unauthorized();
  const hostname = new URL(getBaseUrl(env)).hostname;
  const actorIri = await resolveActorIri(env.DB, handle, hostname);

  if (!actorIri) return json({ error: "No se pudo resolver el destinatario" }, 404);

  return json({
    acct: handle,
    iri: actorIri,
  });
}

async function resolveActorIri(
  db: D1Database,
  handle: string,
  hostname: string
): Promise<string | null> {
  // Passthrough for full IRIs
  if (WELL_KNOWN_HANDLES.test(handle)) {
    return handle;
  }

  const [username, givenDomain] = handle.split("@", 2);
  if (!username) return null;

  // Local user
  if (!givenDomain || givenDomain === hostname) {
    const actor = await getActorByUsername(db, username, hostname);
    if (actor?.isLocal) return actor.id;
    return null;
  }

  // Remote user via WebFinger
  const webfingerUrl = `https://${givenDomain}/.well-known/webfinger?resource=acct:${username}@${givenDomain}`;
  const val = validateOutboundUrl(webfingerUrl);
  if (!val.valid) return null;
  try {
    const res = await fetch(webfingerUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const wf = await res.json() as { links?: { rel: string; href: string }[] };
    const selfLink = wf.links?.find((l) => l.rel === "self");
    if (!selfLink?.href) return null;
    const cached = await fetchAndCacheRemoteActor(db, selfLink.href);
    if (!cached) return selfLink.href;
    const actor = await getActorById(db, cached.id);
    return actor?.id ?? selfLink.href;
  } catch {
    return null;
  }
}