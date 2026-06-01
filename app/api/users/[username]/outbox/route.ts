import { type NextRequest } from "next/server";
import { getCloudflareContext, activityJson, notFound } from "@/lib/cf";
import { getActorByUsername, getActorStatuses, getAttachmentsByObjectIds } from "@/lib/db";
import { buildActor, buildNote, buildCreate, buildOrderedCollection, buildOrderedCollectionPage, objectIRI, actorIRI } from "@/lib/activitypub/utils";
import type { APAttachment, LocalAttachment } from "@/lib/types";

function toAPAttachment(att: LocalAttachment): APAttachment {
  const mimeType = att.mimeType ?? "application/octet-stream";
  let type: APAttachment["type"] = "Document";
  if (mimeType.startsWith("image/")) type = "Image";
  else if (mimeType.startsWith("video/")) type = "Video";
  else if (mimeType.startsWith("audio/")) type = "Audio";
  return {
    id: att.url,
    type,
    mediaType: mimeType,
    url: att.url,
    ...(att.description ? { name: att.description } : {}),
    ...(att.blurhash ? { blurhash: att.blurhash } : {}),
    ...(att.width != null ? { width: att.width } : {}),
    ...(att.height != null ? { height: att.height } : {}),
  };
}

// GET /users/:username/outbox
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { username } = await params;
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  const actor = await getActorByUsername(env.DB, username, domain);
  if (!actor || !actor.isLocal) return notFound("Actor not found");

  const outboxId = `${actorIRI(baseUrl, username)}/outbox`;
  const page = request.nextUrl.searchParams.get("page");

  if (!page) {
    return activityJson(buildOrderedCollection(outboxId, actor.statusesCount));
  }

  const maxId = page !== "true" ? page : undefined;
  const statuses = await getActorStatuses(env.DB, actor.id, 20, maxId);
  const attachmentMap = await getAttachmentsByObjectIds(env.DB, statuses.map((s) => s.id));

  const items = statuses
    .filter((s) => s.visibility === "public")
    .map((s) => {
      const attachments = (attachmentMap.get(s.id) ?? []).map(toAPAttachment);
      const note = buildNote(baseUrl, s.id, {
        actorUsername: username,
        content: s.content ?? "",
        published: s.published,
        visibility: s.visibility as "public" | "unlisted" | "followers" | "direct",
        inReplyTo: s.inReplyToId ?? undefined,
        sensitive: s.sensitive,
        summary: s.contentWarning ?? undefined,
        language: s.language ?? undefined,
      });
      if (attachments.length > 0) {
        note.attachment = attachments;
      }
      return buildCreate(baseUrl, actorIRI(baseUrl, username), note, s.id + "-create");
    });

  const nextId =
    items.length === 20
      ? `${outboxId}?page=${statuses[statuses.length - 1]?.id}`
      : undefined;

  return activityJson(buildOrderedCollectionPage(outboxId, items, nextId));
}
