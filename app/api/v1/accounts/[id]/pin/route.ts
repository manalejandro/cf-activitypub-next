import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorById, getAllCustomEmojis, getActorFields } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(_request.url).hostname;
  const { id } = await params;
  const rawId = decodeURIComponent(id);
  const me = await getAuthenticatedActor(_request, env.DB);
  if (!me) return unauthorized();
  const target = await getActorById(env.DB, rawId);
  if (!target) return notFound();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS endorsements (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, target_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (actor_id, target_id))").run();
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
