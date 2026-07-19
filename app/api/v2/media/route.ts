import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { createAttachment } from "@/lib/db";
import { serializeAttachment } from "@/lib/mastodon/serializers";

export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const me = await getAuthenticatedActor(request, env.DB);
  if (!me) return unauthorized();
  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  if (!file) return json({ error: "File is required" }, 400);
  const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4", "video/webm", "audio/mpeg", "audio/ogg"];
  if (!allowedTypes.includes(file.type)) return json({ error: "Unsupported media type" }, 400);
  if (file.size > 16 * 1024 * 1024) return json({ error: "File too large" }, 413);
  const id = crypto.randomUUID();
  const key = `media/${me.id}/${id}-${file.name}`;
  await env.R2.put(key, file, { httpMetadata: { contentType: file.type } });
  const url = `https://${new URL(request.url).hostname}/api/media/${key}`;
  const att = {
    id,
    objectId: "",
    type: file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "audio",
    url,
    remoteUrl: null,
    description: (formData.get("description") as string | null) ?? null,
    blurhash: null,
    width: null,
    height: null,
    fileSize: file.size,
    mimeType: file.type,
    createdAt: new Date().toISOString(),
  };
  await createAttachment(env.DB, att);

  return json(serializeAttachment(att));
}
