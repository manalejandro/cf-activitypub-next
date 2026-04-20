import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeAccount } from "@/lib/mastodon/serializers";

// GET /api/v1/accounts/verify_credentials
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  return json(serializeAccount(actor, domain, { isCurrentUser: true }));
}

// PATCH /api/v1/accounts/update_credentials
export async function PATCH(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  let body: Record<string, string> = {};
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    body = await request.json();
  } else {
    try {
      const form = await request.formData();
      body = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
    } catch { /* empty */ }
  }

  const updates: Record<string, unknown> = {};
  if (body.display_name !== undefined) updates.displayName = body.display_name;
  if (body.note !== undefined) updates.summary = body.note;
  if (body.locked !== undefined) updates.manuallyApprovesFollowers = body.locked === "true";
  if (body.discoverable !== undefined) updates.discoverable = body.discoverable === "true";

  if (Object.keys(updates).length > 0) {
    await env.DB
      .prepare(
        `UPDATE actors SET
          display_name = COALESCE(?, display_name),
          summary = COALESCE(?, summary),
          manually_approves_followers = COALESCE(?, manually_approves_followers),
          discoverable = COALESCE(?, discoverable),
          updated_at = datetime('now')
        WHERE id = ?`
      )
      .bind(
        updates.displayName ?? null,
        updates.summary ?? null,
        updates.manuallyApprovesFollowers !== undefined ? (updates.manuallyApprovesFollowers ? 1 : 0) : null,
        updates.discoverable !== undefined ? (updates.discoverable ? 1 : 0) : null,
        actor.id
      )
      .run();
  }

  const updated = await env.DB
    .prepare("SELECT * FROM actors WHERE id = ?")
    .bind(actor.id)
    .first();

  return json(serializeAccount(updated as never, domain, { isCurrentUser: true }));
}
