import { type NextRequest } from "next/server";
import { json, badRequest, unauthorized, checkRateLimit } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { addAlias, aliasAcct, removeAlias, resolveAliasTarget } from "@/lib/activitypub/aliases";
import { broadcastActorUpdate } from "@/lib/activitypub/actor-update";
import { env } from "cloudflare:workers";

// Migration aliases (`alsoKnownAs`).
//
// Mastodon only exposes aliases in its web UI (Preferences → Account → "Moving
// from a different account"), with no REST endpoint, so a client needs one.
// The alias is the destination half of a profile move: the OLD account's
// server refuses the Move ("not an alias of this account") unless this account
// lists it in `alsoKnownAs`. Setting one is harmless and reversible, and the
// updated actor document is pushed to the followers so the source instance can
// verify it right away.

function aliasesOf(actor: { alsoKnownAs?: string[] | null }): { uri: string; acct: string }[] {
  return (actor.alsoKnownAs ?? []).map((uri) => ({ uri, acct: aliasAcct(uri) }));
}

// GET /api/v1/accounts/aliases — the aliases this account declares.
export async function GET(request: NextRequest): Promise<Response> {
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  return json({ aliases: aliasesOf(actor) });
}

// POST /api/v1/accounts/aliases — add one. Body: { acct: "user@domain" }.
export async function POST(request: NextRequest): Promise<Response> {
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  // Every alias change broadcasts an Update{Actor} to all followers: a change
  // loop would fan out one activity per request.
  const { allowed: canAlias } = await checkRateLimit(env.KV, `aliases:${actor.id}`, 10, 60);
  if (!canAlias) return json({ error: "Too many requests. Please try again later." }, 429);

  let body: { acct?: unknown };
  try {
    body = (await request.json()) as { acct?: unknown };
  } catch {
    return badRequest("Invalid JSON body");
  }
  const acct = typeof body.acct === "string" ? body.acct : "";
  if (!acct.trim()) return json({ error: "acct is required", error_code: "alias_error_invalid" }, 422);

  const baseUrl = `https://${new URL(request.url).hostname}`;
  const resolution = await resolveAliasTarget(env.DB, baseUrl, acct, actor.id);
  if (!resolution.ok) {
    return json({ error: resolution.error, error_code: resolution.errorCode }, 422);
  }
  if ((actor.alsoKnownAs ?? []).includes(resolution.target.uri)) {
    return json({ error: "That alias already exists", error_code: "alias_error_exists" }, 422);
  }

  const updated = await addAlias(env.DB, actor, resolution.target);
  await broadcastActorUpdate(env, updated, baseUrl);

  return json({ uri: resolution.target.uri, acct: resolution.target.acct, aliases: aliasesOf(updated) });
}

// DELETE /api/v1/accounts/aliases?uri=... — remove one.
export async function DELETE(request: NextRequest): Promise<Response> {
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  // Removing an alias broadcasts Update{Actor} too: same budget as adding one.
  const { allowed: canAlias } = await checkRateLimit(env.KV, `aliases:${actor.id}`, 10, 60);
  if (!canAlias) return json({ error: "Too many requests. Please try again later." }, 429);

  const uri = request.nextUrl.searchParams.get("uri")?.trim() ?? "";
  if (!uri) return badRequest("uri is required");
  if (!(actor.alsoKnownAs ?? []).includes(uri)) {
    return json({ error: "That alias does not exist", error_code: "alias_error_not_found" }, 422);
  }

  const baseUrl = `https://${new URL(request.url).hostname}`;
  const updated = await removeAlias(env.DB, actor, uri);
  await broadcastActorUpdate(env, updated, baseUrl);

  return json({ ok: true, aliases: aliasesOf(updated) });
}
