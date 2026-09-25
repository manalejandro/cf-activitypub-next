import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getActorByUsername } from "@/lib/db";
import { extractSigningKeyId } from "@/lib/activitypub/security";
import { verifyIncomingSignature } from "@/lib/activitypub/signer-key";
import { processInboxActivity } from "@/lib/activitypub/inbox";

// POST /users/:username/inbox
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { username } = await params;
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  const recipient = await getActorByUsername(env.DB, username, domain);
  if (!recipient || !recipient.isLocal || !recipient.privateKeyPem) {
    return notFound("Actor not found");
  }

  let body: string;
  try {
    body = await request.text();
  } catch {
    return json({ error: "Could not read request body" }, 400);
  }

  let activity: Record<string, unknown>;
  try {
    activity = JSON.parse(body);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  // Reject oversized payloads before any parsing work.
  if (body.length > 1_000_000) {
    return json({ error: "Payload too large" }, 413);
  }

  // Verify HTTP signature
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => { headers[key] = value; });

  const actorId = typeof activity.actor === "string"
    ? activity.actor
    : (activity.actor as { id?: string })?.id;

  if (!actorId) {
    return json({ error: "Missing actor" }, 400);
  }

  // The HTTP Signature's keyId identifies the actor that actually signed the
  // request. For relay / forwarded deliveries this will be the forwarding
  // server's actor, NOT the activity's `actor` field.
  const sigKeyId = extractSigningKeyId(headers);
  const signingActorId = sigKeyId ? sigKeyId.replace(/#.*$/, "") : actorId;

  // Use the canonical inbox URL (before middleware rewrite) for signature
  // verification: the sender signed against the original path.
  const canonicalUrl = `${baseUrl}/users/${username}/inbox`;
  const check = await verifyIncomingSignature(env.DB, env.KV, {
    method: "POST",
    url: canonicalUrl,
    headers,
    body,
    signingKeyId: sigKeyId ?? `${actorId}#main-key`,
  });
  if (!check.ok) {
    const detail = check.status ? ` (HTTP ${check.status})` : "";
    console.warn(`[inbox] ${check.reason} for ${signingActorId}${detail}`);
    // `no-key` is retryable (503) so the sender retries with backoff instead of
    // dropping the activity; a gone key or a bad signature is permanent (401).
    return check.reason === "no-key"
      ? json({ error: "Cannot verify signature: no public key" }, 503)
      : json({ error: "Invalid HTTP signature" }, 401);
  }

  try {
    await processInboxActivity(activity as never, {
      db: env.DB,
      kv: env.KV,
      baseUrl,
      recipient: {
        id: recipient.id,
        username: recipient.username,
        privateKeyPem: recipient.privateKeyPem,
      },
      signingActorId,
      signingKey: {
        id: recipient.id,
        privateKeyPem: recipient.privateKeyPem,
      },
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
    // ignore
  }

  return json({}, 202);
}

