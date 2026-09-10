import { getCloudflareContext, json, getBaseUrl } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import {
  getActorById,
  getMlsMessagesByRecipient,
  getMlsKeyPackagesByActor,
  getMlsConversationsByRecipient,
  deleteMlsKeyPackageByObjectId,
  deleteMlsMessageForRecipient,
  deleteMlsMessagesByConversation,
} from "@/lib/db";
import type { NextRequest } from "next/server";

// GET /api/v1/e2ee
//
// View for the E2EE screen: MLS messages (encrypted envelopes), key packages and
// conversations of the authenticated actor. Never decrypts content.

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const baseUrl = getBaseUrl(env);

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return json({ error: "No autorizado" }, 401);

  const messages = await getMlsMessagesByRecipient(env.DB, actor.id, 100);
  // List ALL key packages, active and retired, so the UI can show the lifecycle
  // states (the public keyPackages collection still serves only active ones).
  const keyPackages = await getMlsKeyPackagesByActor(env.DB, actor.id, false);
  const conversations = await getMlsConversationsByRecipient(env.DB, actor.id);

  // Resolve sender display info in one pass (mirrors how timeline statuses embed accounts).
  const senderMap = new Map<string, { id: string; username: string; acct: string; displayName: string; avatarUrl: string | null }>();
  const hostname = new URL(baseUrl).hostname;
  const ids = [...new Set(messages.map((m) => m.actorId))];
  for (const id of ids) {
    const sender = await getActorById(env.DB, id);
    senderMap.set(id, sender
      ? {
          id: sender.id,
          username: sender.username,
          acct: sender.isLocal && sender.domain === hostname ? sender.username : `${sender.username}@${sender.domain}`,
          displayName: sender.displayName ?? sender.username,
          avatarUrl: sender.avatarUrl,
        }
      : { id, username: id, acct: id, displayName: id, avatarUrl: null });
  }

  const domain = new URL(baseUrl).hostname;
  return json({
    me: {
      id: actor.id,
      username: actor.username,
      acct: actor.username,
      displayName: actor.displayName ?? actor.username,
      avatarUrl: actor.avatarUrl,
      acctFull: `${actor.username}@${domain}`,
    },
    baseUrl,
    keyPackagesUrl: `${baseUrl}/users/${actor.username}/keyPackages`,
    messagesUrl: `${baseUrl}/users/${actor.username}/messages`,
    messages: messages.map((m) => ({
      id: m.id,
      recipientId: m.recipientId,
      type: m.type,
      objectType: m.objectType,
      actorId: m.actorId,
      sender: senderMap.get(m.actorId) ?? { id: m.actorId, username: m.actorId, acct: m.actorId, displayName: m.actorId, avatarUrl: null },
      conversation: m.conversation,
      content: m.content,
      published: m.published,
    })),
    keyPackages: keyPackages.map((kp) => ({
      id: kp.id,
      objectId: kp.objectId,
      ciphersuite: kp.ciphersuite,
      encoding: kp.encoding,
      content: kp.content,
      isActive: kp.isActive,
      createdAt: kp.createdAt,
    })),
    conversations,
  });
}

// DELETE /api/v1/e2ee?target=key-package|message|conversation&id=<id>
//
// Deletes the authenticated actor's MLS resource: a key package (by objectId), a
// received message (by id) or a whole conversation (by conversation).

export async function DELETE(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return json({ error: "No autorizado" }, 401);

  const url = new URL(request.url);
  const target = url.searchParams.get("target");
  const id = url.searchParams.get("id");
  if (!target || !id) return json({ error: "Faltan target o id" }, 400);

  if (target === "key-package") {
    await deleteMlsKeyPackageByObjectId(env.DB, id, actor.id);
  } else if (target === "message") {
    await deleteMlsMessageForRecipient(env.DB, actor.id, id);
  } else if (target === "conversation") {
    await deleteMlsMessagesByConversation(env.DB, actor.id, id);
  } else {
    return json({ error: `target desconocido: ${target}` }, 400);
  }

  return json({ ok: true });
}