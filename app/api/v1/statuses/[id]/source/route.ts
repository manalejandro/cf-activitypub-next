import { type NextRequest } from "next/server";
import { getCloudflareContext, getInstanceTitle, json, notFound } from "@/lib/cf";
import { getObjectById, isAcceptedFollower, canViewStatus } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { decodeStatusId } from "@/lib/mastodon/statusId";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(_request.url).hostname;
  const rawId = (await params).id;
  const id = decodeStatusId(rawId, domain);
  const obj = await getObjectById(env.DB, id);
  if (!obj) return notFound();
  const me = await getAuthenticatedActor(_request, env.DB);
  const isFollowing = me ? await isAcceptedFollower(env.DB, me.id, obj.actorId) : false;
  if (!canViewStatus(obj, me?.id ?? null, isFollowing)) return notFound();
  return json({
    id,
    text: (obj.content ?? "").replace(/<[^>]*>/g, ""),
    content_warning: obj.contentWarning ?? null,
    language: obj.language ?? null,
    poll: null,
    media_attachments: [],
    sensitive: obj.sensitive,
    spoiler_text: obj.contentWarning ?? null,
    created_at: obj.published,
    updated_at: obj.updatedAt ?? obj.published,
    application: obj.local ? { name: getInstanceTitle(), website: null } : null,
  });
}
