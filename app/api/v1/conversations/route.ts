import { type NextRequest } from "next/server";
import { json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getConversations, getObjectsByIds, getActorsByIds, getActorByUri, getLastStatusAtMap, deleteConversation, getAttachmentsByObjectIds } from "@/lib/db";
import { serializeStatus, serializeAccount } from "@/lib/mastodon/serializers";
import { clampLimit, resolveLimits } from "@/lib/constants";
import { getFilterResultsForStatuses } from "@/lib/mastodon/filters";
import { getStatusAuthorExtras } from "@/lib/mastodon/account-extras";
import type { LocalActor, LocalObject } from "@/lib/types";
import { env } from "cloudflare:workers";

// IRIs of the other participants of a direct object: everyone addressed in
// to/cc/mentions except the viewer. Public/collection recipients are skipped.
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

export async function GET(request: NextRequest): Promise<Response> {
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const limit = clampLimit(request.nextUrl.searchParams.get("limit"), limits.defaultTimelinePage, limits.maxPageSize);

  const conversations = await getConversations(env.DB, actor.id, limit);

  // Batch every lookup (AGENTS: never a round trip per row). The old code did
  // ~6 queries per conversation (object, author, filters, last-status-at,
  // author extras, attachments) plus one per participant — >100 round trips for
  // a page of 20. Resolve all objects, then all actors (authors + participants),
  // then the enrichment maps in one parallel round.
  const lastIds = conversations.map((c) => c.last_status_id).filter((v): v is string => !!v);
  const objectMap = await getObjectsByIds(env.DB, lastIds);

  // A conversation whose latest message is gone must not linger as an empty
  // entry (messages can be deleted from the status page, a federated Delete, an
  // account purge…): drop it, mirroring deleteObject.
  const live: { c: (typeof conversations)[number]; obj: LocalObject }[] = [];
  for (const c of conversations) {
    const obj = c.last_status_id ? objectMap.get(c.last_status_id) : undefined;
    if (!obj) {
      await deleteConversation(env.DB, c.id);
      continue;
    }
    live.push({ c, obj });
  }
  if (live.length === 0) return json([]);

  const objs = live.map((x) => x.obj);
  const authorIds = [...new Set(objs.map((o) => o.actorId))];
  // Participants of direct conversations are http IRIs (otherParticipantIds
  // skips non-http), i.e. actor ids — resolve them in the same batch as authors.
  const participantIds = new Set<string>();
  for (const x of live) {
    if (x.obj.visibility === "direct") {
      for (const pid of otherParticipantIds(x.obj.raw, actor.id)) participantIds.add(pid);
    }
  }
  const allActorIds = [...new Set([...authorIds, ...participantIds])];

  const [actorsMap, filteredMap, lastStatusAtMap, authorExtrasMap, attachmentsMap] = await Promise.all([
    getActorsByIds(env.DB, allActorIds),
    getFilterResultsForStatuses(env.DB, actor.id, objs),
    getLastStatusAtMap(env.DB, authorIds),
    getStatusAuthorExtras(env.DB, authorIds, domain),
    getAttachmentsByObjectIds(env.DB, objs.map((o) => o.id)),
  ]);

  // A participant the exact-id batch missed may be addressed with another IRI
  // spelling (a `https://host/@user` href, or an id that differs from the
  // canonical one cached by upsertRemoteActor): getActorByUri also matches by
  // username+host. Bounded per-id fallback, only for the misses of this page —
  // without it the conversation rendered with an empty `accounts` list.
  const fallbackActors = new Map<string, LocalActor>();
  for (const pid of participantIds) {
    if (actorsMap.has(pid)) continue;
    const resolved = await getActorByUri(env.DB, pid);
    if (resolved) fallbackActors.set(pid, resolved);
  }

  const result = live.map(({ c, obj }) => {
    let lastStatus = null;
    let accounts: unknown[] = [];
    const author = actorsMap.get(obj.actorId) ?? null;
    if (author) {
      const lastStatusFiltered = filteredMap.get(obj.id);
      const authorLastStatusAt = lastStatusAtMap.get(obj.actorId) ?? null;
      const authorExtras = authorExtrasMap.get(obj.actorId);
      const lastAttachments = attachmentsMap.get(obj.id) ?? [];
      lastStatus = serializeStatus(obj, author, domain, { attachments: lastAttachments, filtered: lastStatusFiltered, authorLastStatusAt, authorSupportsCalls: authorExtras?.supportsCalls, authorMoved: authorExtras?.moved ?? null });
      if (obj.visibility === "direct") {
        // The conversation is "with" everyone addressed except the viewer;
        // fall back to the last author when no other participant resolves.
        const others = otherParticipantIds(obj.raw, actor.id);
        let other = null;
        for (const oid of others) {
          const oa = actorsMap.get(oid) ?? fallbackActors.get(oid);
          if (oa) { other = oa; break; }
        }
        if (other) accounts = [serializeAccount(other, domain)];
        else if (author.id !== actor.id) accounts = [serializeAccount(author, domain)];
      }
    }

    return {
      id: c.id,
      unread: c.unread,
      accounts,
      last_status: lastStatus,
    };
  });

  return json(result);
}
