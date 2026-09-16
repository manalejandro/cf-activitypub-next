import { type NextRequest } from "next/server";
import { json, getCloudflareContext } from "@/lib/cf";
import { getObjectById, getObjectEditHistory, getActorById, isAcceptedFollower, canViewStatus } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { decodeStatusId } from "@/lib/mastodon/statusId";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const domain = new URL(request.url).hostname;

  const obj = await getObjectById(env.DB, decodeStatusId(id, domain));
  if (!obj) return json([]);
  const me = await getAuthenticatedActor(request, env.DB);
  const isFollowing = me ? await isAcceptedFollower(env.DB, me.id, obj.actorId) : false;
  if (!canViewStatus(obj, me?.id ?? null, isFollowing)) return json([]);

  const actor = await getActorById(env.DB, obj.actorId);
  if (!actor) return json([]);

  const edits = await getObjectEditHistory(env.DB, obj.id);
  const account = serializeAccount(actor, domain);

  return json(
    edits.map((e) => ({
      content: e.content ?? "",
      spoiler_text: e.contentWarning ?? "",
      sensitive: e.sensitive,
      created_at: e.createdAt,
      account,
    }))
  );
}
