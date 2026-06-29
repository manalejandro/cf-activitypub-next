import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getActorByUsername, getActorById, upsertRemoteActor } from "@/lib/db";
import { verifySignature, extractSigningKeyId } from "@/lib/activitypub/security";
import { processInboxActivity } from "@/lib/activitypub/inbox";
import { fetchRemoteObject } from "@/lib/activitypub/federation";
import type { APActor } from "@/lib/types";

// POST /users/:username/inbox
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { username } = await params;
  console.log("[inbox/user] POST received for", username, "from", request.headers.get("user-agent") ?? "unknown");
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

  // Fetch remote actor to get public key
  let remoteActor: APActor | null = null;
  try {
    // Check cache first
    const cached = await env.DB
      .prepare("SELECT * FROM actors WHERE id = ?")
      .bind(signingActorId)
      .first<{ public_key_pem: string; inbox: string }>();

    if (cached) {
      remoteActor = { id: signingActorId, publicKey: { id: sigKeyId ?? `${signingActorId}#main-key`, owner: signingActorId, publicKeyPem: cached.public_key_pem }, type: "Person", preferredUsername: "", inbox: cached.inbox, outbox: "", followers: "", following: "" };
    } else {
      const fetched = await fetchRemoteObject(
        signingActorId,
        `${recipient.id}#main-key`,
        recipient.privateKeyPem
      );
      if (fetched && "publicKey" in fetched) {
        remoteActor = fetched as APActor;
        // Cache the remote actor so subsequent activities don't require a
        // network round-trip and so handleCreate can find the author.
        try { await upsertRemoteActor(env.DB, remoteActor); } catch { /* ignore */ }
      }
    }
  } catch {
    // ignore fetch errors, proceed with signature check
  }

  if (!remoteActor?.publicKey?.publicKeyPem) {
    console.error("[inbox/user] Could not retrieve public key for signing actor %s — rejecting", signingActorId);
    return json({ error: "Cannot verify signature: no public key" }, 401);
  }

  // Use the canonical inbox URL (before middleware rewrite) for signature verification.
  // Middleware rewrites /users/:username/inbox → /api/users/:username/inbox, but the
  // sender signed against the original path.
  const canonicalUrl = `${baseUrl}/users/${username}/inbox`;
  const valid = await verifySignature(
    "POST",
    canonicalUrl,
    headers,
    remoteActor.publicKey.publicKeyPem,
    body
  );
  if (!valid && env.NODE_ENV !== "development") {
    console.error("[inbox/user] Invalid signature from actor %s for %s inbox", actorId, username);
    return json({ error: "Invalid signature" }, 401);
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
      signingKey: {
        id: recipient.id,
        privateKeyPem: recipient.privateKeyPem,
      },
      timelineStream: env.TIMELINE_STREAM,
    });
  } catch (err) {
    console.error("[inbox/user] processInboxActivity threw for %s inbox, activity %s: %s", username, (activity as { id?: string }).id, err);
  }

  return json({}, 202);
}

// GET /users/:username/inbox (not publicly readable)
export async function GET(): Promise<Response> {
  return json({ error: "Forbidden" }, 403);
}
