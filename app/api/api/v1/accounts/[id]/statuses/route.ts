import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getActorById, getActorStatuses, getActorStatuses_withReplies, getAttachmentsByObjectIds } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatus } from "@/lib/mastodon/serializers";
import { decodeStatusId } from "@/lib/mastodon/statusId";

// GET /api/v1/accounts/:id/statuses
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const domain = new URL(request.url).hostname;
  const searchParams = request.nextUrl.searchParams;

  const limit = Math.min(parseInt(searchParams.get("limit") ?? "20"), 40);
  const maxIdRaw = searchParams.get("max_id") ?? undefined;
  const maxId = maxIdRaw ? decodeStatusId(maxIdRaw, domain) : undefined;
  const onlyReplies = searchParams.get("only_replies") === "true";

  const actor = await getActorById(env.DB, decodeURIComponent(id));
  if (!actor) return notFound("Account not found");

  const me = await getAuthenticatedActor(request, env.DB);

  const objects = onlyReplies
    ? await getActorStatuses_withReplies(env.DB, actor.id, limit, maxId)
    : await getActorStatuses(env.DB, actor.id, limit, maxId);
  const attachmentMap = await getAttachmentsByObjectIds(env.DB, objects.map((o) => o.id));

  const statuses = objects.map((obj) =>
    serializeStatus(obj, actor, domain, {
      attachments: attachmentMap.get(obj.id) ?? [],
      favourited: false,
      reblogged: false,
    })
  );

  return json(statuses);
}
