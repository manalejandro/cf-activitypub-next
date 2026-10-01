import { type NextRequest } from "next/server";
import type { D1Database } from "@cloudflare/workers-types";
import { getBaseUrl, getCloudflareContext, json, badRequest } from "@/lib/cf";
import { getAdminRole, requireAdmin } from "@/lib/admin-auth";
import { createRelay, deleteRelay, getRelayById, getRelayByInbox, listRelays } from "@/lib/db";
import { disableRelay, enableRelay, normalizeRelayInbox } from "@/lib/activitypub/relays";
import { recordModeration } from "@/lib/moderation/log";
import { generateId } from "@/lib/activitypub/utils";
import type { LocalRelay } from "@/lib/types";

/** Audit every relay mutation in the moderation log. */
async function logRelay(
  env: { DB: D1Database },
  action: string,
  targetId: string,
  reason: string,
  details: Record<string, unknown> = {}
): Promise<void> {
  await recordModeration(env, {
    id: generateId(),
    source: "user",
    targetType: "relay",
    targetId,
    action,
    reason,
    confidence: null,
    model: "admin",
    details,
    emailSent: false,
    emailTo: null,
    relatedId: null,
  });
}

// GET /api/v1/admin/relays — subscribed ActivityPub relays with their state.
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
  const relays = await listRelays(env.DB);
  return json({ relays, total: relays.length });
}

// POST /api/v1/admin/relays — add a relay or change its subscription state.
// body: { action: "add" | "enable" | "disable" | "remove", inbox_url?, id? }
export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const role = await getAdminRole(request, env);
  if (role !== "admin") {
    // Authenticated moderators get a 403 (they can see the section); anonymous
    // callers get 401, mirroring /api/v1/admin/instances.
    return json({ error: role ? "Administrator role required" : "Unauthorized" }, role ? 403 : 401);
  }

  let body: { inbox_url?: unknown; id?: unknown; action?: unknown };
  try {
    body = (await request.json()) as { inbox_url?: unknown; id?: unknown; action?: unknown };
  } catch {
    return badRequest("Invalid JSON body");
  }
  const action = typeof body.action === "string" ? body.action : "add";
  const baseUrl = getBaseUrl(env);

  if (action === "add") {
    const inboxUrl = normalizeRelayInbox(typeof body.inbox_url === "string" ? body.inbox_url : "");
    if (!inboxUrl) return badRequest("inbox_url must be a public https URL");
    const existing = await getRelayByInbox(env.DB, inboxUrl);
    const relay = existing ?? (await createRelay(env.DB, generateId(), inboxUrl));
    if (!relay) return json({ error: "Could not store the relay" }, 500);
    if (!existing) {
      await logRelay(env, "relay_added", relay.inboxUrl, "Relay added by an administrator.", { state: relay.state });
    }
    return json({ ok: true, relay });
  }

  const id = typeof body.id === "string" ? body.id : "";
  const relay: LocalRelay | null = id ? await getRelayById(env.DB, id) : null;
  if (!relay) return json({ error: "Relay not found" }, 404);

  switch (action) {
    case "enable": {
      const updated = await enableRelay(env, relay, baseUrl);
      if (!updated) return json({ error: "No local signing actor available" }, 500);
      await logRelay(env, "relay_enabled", relay.inboxUrl, "Relay subscription requested by an administrator.", {
        state: updated.state,
      });
      return json({ ok: true, relay: updated });
    }
    case "disable": {
      const updated = await disableRelay(env, relay, baseUrl);
      await logRelay(env, "relay_disabled", relay.inboxUrl, "Relay unsubscribed by an administrator.");
      return json({ ok: true, relay: updated });
    }
    case "remove": {
      // An enabled relay must be told to stop pushing before we forget it.
      if (relay.state === "pending" || relay.state === "accepted") {
        await disableRelay(env, relay, baseUrl);
      }
      await deleteRelay(env.DB, relay.id);
      await logRelay(env, "relay_removed", relay.inboxUrl, "Relay removed by an administrator.");
      return json({ ok: true });
    }
    default:
      return badRequest("Unknown action");
  }
}
