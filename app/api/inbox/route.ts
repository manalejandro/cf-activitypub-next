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
  // Reject oversized payloads before any parsing work (1 MB is far above any
  // legitimate AP activity we accept).
  if (rawBody.length > 1_000_000) {
    return json({ error: "Payload too large" }, 413);
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
        signingKey ? `${signingKey.id}#main-key` : undefined,
        signingKey?.privateKeyPem,
      ) as APActor | null;
      // Never cache a document whose id differs from the actor we asked for:
      // a malicious server could otherwise return an actor document pointing at
      // another (local or remote) account and poison the key cache.
      if (fetched?.id === signingActorId && fetched.publicKey?.publicKeyPem) {
        senderActor = fetched;
        try { await upsertRemoteActor(env.DB, senderActor); } catch { /* ignore */ }
      }
    }
  } catch {
    // ignore
  }

  if (!senderActor?.publicKey?.publicKeyPem) {
    return json({ error: "Cannot verify signature: no public key" }, 401);
  }

  // Mastodon spec step 5: the Date header is required and must be within 12 hours.
  const dateHeader = headers["date"];
  const requestDate = dateHeader ? new Date(dateHeader) : null;
  if (!requestDate || isNaN(requestDate.getTime()) || Math.abs(Date.now() - requestDate.getTime()) > 12 * 36e5) {
    return json({ error: "Request date missing, invalid, or too old" }, 401);
  }

  const valid = await verifySignature("POST", `${baseUrl}/inbox`, headers, senderActor.publicKey.publicKeyPem, rawBody);
  if (!valid) {
    return json({ error: "Invalid HTTP signature" }, 401);
  }

  try {
    await processInboxActivity(body as never, {
      db: env.DB,
      kv: env.KV,
      baseUrl,
      signingActorId,
      signingKey,
      timelineStream: env.TIMELINE_STREAM,
      deliveryQueue: env.DELIVERY_QUEUE,
      vapidPublicKey: env.VAPID_PUBLIC_KEY,
      vapidPrivateKey: env.VAPID_PRIVATE_KEY,
      vapidEmail: env.VAPID_EMAIL,
      ai: env.AI,
      email: env.EMAIL,
      fromEmail: env.FROM_EMAIL,
      instanceTitle: env.INSTANCE_TITLE,
    });
  } catch {
    // Still return 202 so the remote server does not keep retrying.
  }

  return json({ status: "accepted" }, 202);
}
