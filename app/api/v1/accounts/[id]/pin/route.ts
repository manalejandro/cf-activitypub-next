import { type NextRequest } from "next/server";
import { json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorById, getAllCustomEmojis, getActorFields, getFollow } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { env } from "cloudflare:workers";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const domain = new URL(_request.url).hostname;
  const { id } = await params;
  const rawId = decodeURIComponent(id);
  const me = await getAuthenticatedActor(_request, env.DB);
  if (!me) return unauthorized();
  const target = await getActorById(env.DB, rawId);
  if (!target) return notFound();
  // Mastodon's AccountPin validates the follow relationship before featuring an
  // account on your profile (a recommendation of an account you do not follow
  // is not one). Featuring an account is local-only: it is never federated.
  const follow = await getFollow(env.DB, me.id, rawId);
  if (follow?.state !== "accepted") {
    return json({ error: "Validation failed: You must be following the account to feature it" }, 422);
  }
  const eid = crypto.randomUUID();
  await env.DB
    .prepare("INSERT OR IGNORE INTO endorsements (id, actor_id, target_id) VALUES (?, ?, ?)")
    .bind(eid, me.id, rawId)
    .run();
  const [emojis, fields] = await Promise.all([
    getAllCustomEmojis(env.DB),
    getActorFields(env.DB, rawId),
  ]);
  return json(serializeAccount(target, domain, { emojis, fields }));
}
