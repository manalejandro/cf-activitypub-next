import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { processInboxActivity } from "@/lib/activitypub/inbox";
import { verifySignature } from "@/lib/activitypub/security";
import { fetchRemoteObject } from "@/lib/activitypub/federation";
import { getActorById } from "@/lib/db";
import type { APActor } from "@/lib/types";

// POST /inbox — Shared inbox for federation delivery
export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const actorId = typeof body.actor === "string" ? body.actor : (body.actor as { id?: string })?.id;
  if (!actorId) return json({ error: "Missing actor" }, 400);

  let senderActor: APActor | null = null;
  try {
    const cached = await getActorById(env.DB, actorId);
    if (cached) {
      senderActor = cached as unknown as APActor;
    } else {
      senderActor = await fetchRemoteObject(actorId) as APActor | null;
    }
  } catch { /* ignore */ }

  if (senderActor?.publicKey?.publicKeyPem) {
    const method = "POST";
    const url = `${baseUrl}/inbox`;
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => { headers[k] = v; });

    const valid = await verifySignature(method, url, headers, senderActor.publicKey.publicKeyPem);
    if (!valid) return json({ error: "Invalid HTTP signature" }, 401);
  }

  await processInboxActivity(body as never, {
    db: env.DB,
    baseUrl,
  });

  return json({ status: "accepted" }, 202);
}
