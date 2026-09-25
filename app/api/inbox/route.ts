import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { processInboxActivity } from "@/lib/activitypub/inbox";
import { extractSigningKeyId } from "@/lib/activitypub/security";
import { purgeGoneSelfDelete, verifyIncomingSignature } from "@/lib/activitypub/signer-key";

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

  // Local signing key used by the activity handlers for outbound fetches.
  let signingKey: { id: string; privateKeyPem: string } | undefined;
  try {
    const localRow = await env.DB
      .prepare("SELECT id, private_key_pem FROM actors WHERE is_local = 1 AND private_key_pem IS NOT NULL LIMIT 1")
      .first<{ id: string; private_key_pem: string }>();
    if (localRow?.private_key_pem) {
      signingKey = { id: localRow.id, privateKeyPem: localRow.private_key_pem };
    }
  } catch { /* ignore */ }

  const check = await verifyIncomingSignature(env.DB, env.KV, {
    method: "POST",
    url: `${baseUrl}/inbox`,
    headers,
    body: rawBody,
    signingKeyId: sigKeyId ?? `${actorId}#main-key`,
  });
  if (!check.ok) {
    const detail = check.status ? ` (HTTP ${check.status})` : "";
    const activityType = typeof body.type === "string" ? body.type : "";
    const activityObject = body.object;
    const activityObjectId = typeof activityObject === "string" ? activityObject : (activityObject as { id?: string } | undefined)?.id ?? "";
    const purged = await purgeGoneSelfDelete(env.DB, check, body, signingActorId);
    console.warn(
      `[inbox] ${check.reason} for ${signingActorId}${detail} type=${activityType || "?"}` +
      `${activityObjectId ? ` object=${activityObjectId}` : ""}${purged ? " (purged cached copy)" : ""}`
    );
    // `no-key` is retryable (503) so the sender retries with backoff instead of
    // dropping the activity; a gone key or a bad signature is permanent (401).
    return check.reason === "no-key"
      ? json({ error: "Cannot verify signature: no public key" }, 503)
      : json({ error: "Invalid HTTP signature" }, 401);
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
