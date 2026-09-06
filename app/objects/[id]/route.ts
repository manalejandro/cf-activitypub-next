import { type NextRequest } from "next/server";
import { getCloudflareContext, notFound } from "@/lib/cf";
import { getObjectById, getActorById, getAttachmentsByObjectId } from "@/lib/db";
import { buildNote } from "@/lib/activitypub/utils";
import type { APAttachment, APTag, LocalAttachment } from "@/lib/types";

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

// GET /objects/:id — serve a local AP Note to remote servers
// For browser requests (HTML), redirect to the human-readable /statuses/:id page.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  // Redirect browsers to the UI page; AP clients get the JSON.
  const accept = request.headers.get("accept") ?? "";
  if (!accept.includes("application/json") && !accept.includes("application/ld+json") && !accept.includes("application/activity+json")) {
    return Response.redirect(`${baseUrl}/statuses/${id}`, 302);
  }

  // Federated fetches (especially bursts from a peer) can hammer D1. Cache the
  // AP response briefly so repeated requests don't re-run the DB queries.
  const cacheKey = `ap:obj:${id}`;
  const cached = await env.KV.get(cacheKey);
  if (cached) {
    return new Response(cached, { headers: { "Content-Type": "application/activity+json; charset=utf-8" } });
  }

  const objectId = `${baseUrl}/objects/${id}`;
  const obj = await getObjectById(env.DB, objectId);
  if (!obj || !obj.local) return notFound("Object not found");

  const author = await getActorById(env.DB, obj.actorId);
  if (!author || !author.isLocal) return notFound("Object not found");

  const rawAttachments = await getAttachmentsByObjectId(env.DB, objectId);
  const apAttachments = rawAttachments.map(toAPAttachment);

  let tags: APTag[] | undefined;
  let to: string[] | undefined;
  let cc: string[] | undefined;
  try {
    const raw = JSON.parse(obj.raw);
    if (Array.isArray(raw.tag)) tags = raw.tag as APTag[];
    if (Array.isArray(raw.to)) to = raw.to as string[];
    if (Array.isArray(raw.cc)) cc = raw.cc as string[];
  } catch { /* ignore parse errors */ }

  const note = buildNote(baseUrl, id, {
    actorUsername: author.username,
    content: obj.content ?? "",
    published: obj.published,
    visibility: obj.visibility as "public" | "unlisted" | "followers" | "direct",
    inReplyTo: obj.inReplyToId ?? undefined,
    sensitive: obj.sensitive,
    summary: obj.contentWarning ?? undefined,
    language: obj.language ?? undefined,
    attachments: apAttachments.length > 0 ? apAttachments : undefined,
    tags,
    to,
    cc,
  });

  // FEP-044f: expose the quoted post so remote instances can verify the quote
  // (Mastodon fetches this object as the QuoteRequest `instrument`).
  if (obj.quoteId) {
    (note as Record<string, unknown>).quote = obj.quoteId;
  }

  const body = JSON.stringify(note);
  await env.KV.put(cacheKey, body, { expirationTtl: 120 }).catch(() => {});
  return new Response(body, { headers: { "Content-Type": "application/activity+json; charset=utf-8" } });
}
