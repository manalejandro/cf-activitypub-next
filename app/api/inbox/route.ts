import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { processInboxActivity } from "@/lib/activitypub/inbox";
import { verifySignature, extractSigningKeyId } from "@/lib/activitypub/security";
import { fetchRemoteObject } from "@/lib/activitypub/federation";
import { getActorById, upsertRemoteActor } from "@/lib/db";
import type { APActor } from "@/lib/types";

// POST /inbox — Shared inbox for federation delivery
export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  // Read body as text so we can parse JSON ourselves (needed for future digest
  // verification without a second read).
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return json({ error: "Could not read request body" }, 400);
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const actorId = typeof body.actor === "string" ? body.actor : (body.actor as { id?: string })?.id;
  if (!actorId) return json({ error: "Missing actor" }, 400);

  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => { headers[k] = v; });

  // The HTTP Signature's keyId identifies the actor that actually signed the
  // request. For relay / forwarded deliveries this will be the forwarding
  // server's actor, NOT the activity's `actor` field. Always verify against
  // the signing actor so relayed activities are accepted.
  const sigKeyId = extractSigningKeyId(headers);
  const signingActorId = sigKeyId ? sigKeyId.replace(/#.*$/, "") : actorId;

  // Fetch local signing key first — needed for authorized fetch (signed GET)
  // when resolving remote actors on instances that require it.
  let signingKey: { id: string; privateKeyPem: string } | undefined;
  try {
    const localRow = await env.DB
      .prepare("SELECT id, private_key_pem FROM actors WHERE is_local = 1 AND private_key_pem IS NOT NULL LIMIT 1")
      .first<{ id: string; private_key_pem: string }>();
    if (localRow?.private_key_pem) {
      signingKey = { id: localRow.id, privateKeyPem: localRow.private_key_pem };
    }
  } catch { /* ignore */ }

  let senderActor: APActor | null = null;
  try {
    const cached = await getActorById(env.DB, signingActorId);
    if (cached?.publicKeyPem) {
      // Reconstruct a minimal APActor from the cached row so signature
      // verification can use the stored public key.
      senderActor = {
        id: cached.id,
        type: (cached.isBot ? "Service" : "Person") as APActor["type"],
        preferredUsername: cached.username,
        inbox: cached.inbox ?? `${signingActorId}/inbox`,
        outbox: `${signingActorId}/outbox`,
        followers: `${signingActorId}/followers`,
        following: `${signingActorId}/following`,
        publicKey: {
          id: sigKeyId ?? `${signingActorId}#main-key`,
          owner: signingActorId,
          publicKeyPem: cached.publicKeyPem,
        },
      };
    } else {
      // Not cached or cached without a public key — fetch from remote.
      // Pass the local signing key so the GET is signed (required by instances
      // with authorized fetch / secure mode enabled).
      const fetched = await fetchRemoteObject(
        signingActorId,
        signingKey?.id,
        signingKey?.privateKeyPem,
      ) as APActor | null;
      if (fetched && fetched.publicKey?.publicKeyPem) {
        senderActor = fetched;
        // Cache actor so subsequent requests don't need a network round-trip.
        try { await upsertRemoteActor(env.DB, senderActor); } catch { /* ignore */ }
      }
    }
  } catch (err) {
    console.error(`[inbox/shared] Error fetching signing actor ${signingActorId}: ${err}`);
  }

  if (!senderActor?.publicKey?.publicKeyPem) {
    console.error(
      `[inbox/shared] No public key found for signing actor ${signingActorId} (activity actor: ${actorId}, keyId: ${sigKeyId ?? "(none)"}) — rejecting`
    );
    return json({ error: "Cannot verify signature: no public key" }, 401);
  }

  const valid = await verifySignature("POST", `${baseUrl}/inbox`, headers, senderActor.publicKey.publicKeyPem);
  if (!valid) {
    console.error(
      `[inbox/shared] Invalid HTTP signature — activity actor: ${actorId} | signing actor: ${signingActorId} | keyId: ${sigKeyId ?? "(none)"} | signature header: ${headers["signature"] ?? headers["Signature"] ?? "(none)"}`
    );
    return json({ error: "Invalid HTTP signature" }, 401);
  }

  try {
    await processInboxActivity(body as never, {
      db: env.DB,
      baseUrl,
      signingKey,
      timelineStream: env.TIMELINE_STREAM,
    });
  } catch (err) {
    console.error(`[inbox/shared] processInboxActivity threw for activity ${(body as { id?: string }).id}: ${err}\nraw body: ${rawBody}`);
    // Still return 202 so the remote server does not keep retrying.
  }

  return json({ status: "accepted" }, 202);
}
