import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getConversationById, deleteConversation, getObjectById, getActorById, getActorByUri } from "@/lib/db";
import { serializeStatus, serializeAccount } from "@/lib/mastodon/serializers";
import { getFilterResultsForStatuses } from "@/lib/mastodon/filters";

function otherParticipantIds(raw: string, ownerId: string): string[] {
  const seen = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v !== "string" || !v.startsWith("http")) return;
    if (v === ownerId || v.includes("/followers") || v.includes("#Public") || v.includes("#public")) return;
    seen.add(v);
  };
  try {
    const o = JSON.parse(raw) as { to?: unknown; cc?: unknown; tag?: unknown };
    for (const key of ["to", "cc"] as const) {
      const v = o[key];
      if (Array.isArray(v)) v.forEach(add);
      else add(v);
    }
    if (Array.isArray(o.tag)) {
      for (const tag of o.tag) {
        if (tag && typeof tag === "object" && (tag as { type?: string }).type === "Mention") {
          add((tag as { href?: unknown }).href);
        }
      }
    }
  } catch { /* ignore malformed raw */ }
  return [...seen];
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const conv = await getConversationById(env.DB, id);
  if (!conv || conv.actor_id !== actor.id) return notFound();

  let lastStatus = null;
  let accounts: unknown[] = [];
  if (conv.last_status_id) {
    const obj = await getObjectById(env.DB, conv.last_status_id);
    if (obj) {
      const author = await getActorById(env.DB, obj.actorId);
      if (author) {
        lastStatus = serializeStatus(obj, author, domain, { filtered: (await getFilterResultsForStatuses(env.DB, actor.id, [obj])).get(obj.id) ?? [] });
        if (obj.visibility === "direct") {
          const others = otherParticipantIds(obj.raw, actor.id);
          let other = null;
          for (const oid of others) {
            const oa = await getActorByUri(env.DB, oid);
            if (oa) { other = oa; break; }
          }
          if (other) accounts = [serializeAccount(other, domain)];
          else if (author.id !== actor.id) accounts = [serializeAccount(author, domain)];
        }
      }
    }
  }

  return json({ id: conv.id, unread: conv.unread, accounts, last_status: lastStatus });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const conv = await getConversationById(env.DB, id);
  if (!conv) return notFound();
  if (conv.actor_id !== actor.id) return notFound();

  await deleteConversation(env.DB, id);
  return json({});
}