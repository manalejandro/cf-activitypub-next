import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getConversations, getObjectById, getActorById, getActorByUri } from "@/lib/db";
import { serializeStatus, serializeAccount } from "@/lib/mastodon/serializers";
import { resolveLimits } from "@/lib/constants";
import { getFilterResultsForStatuses } from "@/lib/mastodon/filters";

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
  const { env } = getCloudflareContext();
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? String(limits.defaultTimelinePage)), limits.maxPageSize);

  const conversations = await getConversations(env.DB, actor.id, limit);

  const result = await Promise.all(
    conversations.map(async (c) => {
      let lastStatus = null;
      let accounts: unknown[] = [];
      let lastStatusFiltered: import("@/lib/mastodon/filters").FilterResult[] | undefined;

      if (c.last_status_id) {
        const obj = await getObjectById(env.DB, c.last_status_id);
        if (obj) lastStatusFiltered = (await getFilterResultsForStatuses(env.DB, actor.id, [obj])).get(obj.id);
        if (obj) {
          const author = await getActorById(env.DB, obj.actorId);
          if (author) {
            lastStatus = serializeStatus(obj, author, domain, { filtered: lastStatusFiltered });
            if (obj.visibility === "direct") {
              // The conversation is "with" everyone addressed except the viewer;
              // fall back to the last author when no other participant resolves.
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

      return {
        id: c.id,
        unread: c.unread,
        accounts,
        last_status: lastStatus,
      };
    })
  );

  return json(result);
}
