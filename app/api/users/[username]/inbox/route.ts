import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getActorByUsername } from "@/lib/db";
import { verifySignature } from "@/lib/activitypub/security";
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

  // Fetch remote actor to get public key
  let remoteActor: APActor | null = null;
  try {
    // Check cache first
    const cached = await env.DB
      .prepare("SELECT * FROM actors WHERE id = ?")
      .bind(actorId)
      .first<{ public_key_pem: string; inbox: string }>();

    if (cached) {
      remoteActor = { id: actorId, publicKey: { id: `${actorId}#main-key`, owner: actorId, publicKeyPem: cached.public_key_pem }, type: "Person", preferredUsername: "", inbox: cached.inbox, outbox: "", followers: "", following: "" };
    } else {
      const fetched = await fetchRemoteObject(
        actorId,
        `${recipient.id}#main-key`,
        recipient.privateKeyPem
      );
      if (fetched && "publicKey" in fetched) {
        remoteActor = fetched as APActor;
      }
    }
  } catch {
    // ignore fetch errors, proceed with signature check
  }

  if (remoteActor?.publicKey?.publicKeyPem) {
    const valid = await verifySignature(
      "POST",
      request.url,
      headers,
      remoteActor.publicKey.publicKeyPem
    );
    if (!valid && env.NODE_ENV !== "development") {
      return json({ error: "Invalid signature" }, 401);
    }
  }

  await processInboxActivity(activity as never, {
    db: env.DB,
    baseUrl,
    recipient: {
      id: recipient.id,
      username: recipient.username,
      privateKeyPem: recipient.privateKeyPem,
    },
  });

  return json({}, 202);
}

// GET /users/:username/inbox (not publicly readable)
export async function GET(): Promise<Response> {
  return json({ error: "Forbidden" }, 403);
}
