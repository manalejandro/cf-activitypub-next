import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeAttachment } from "@/lib/mastodon/serializers";
import { resolveLimits, SUPPORTED_MEDIA_MIME_TYPES } from "@/lib/constants";

export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const me = await getAuthenticatedActor(request, env.DB);
  if (!me) return unauthorized();
  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  if (!file) return json({ error: "File is required" }, 400);
  if (!SUPPORTED_MEDIA_MIME_TYPES.includes(file.type)) return json({ error: "Unsupported media type" }, 400);
  if (file.size > limits.maxImageSize) return json({ error: "File too large" }, 413);
  const id = crypto.randomUUID();
  const key = `media/${me.username}/${id}-${file.name}`;
  const buffer = await file.arrayBuffer();
  await env.R2.put(key, buffer, { httpMetadata: { contentType: file.type } });
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
    sensitive: false,
    createdAt: new Date().toISOString(),
  };
  await env.KV.put(`pending_media:${id}`, JSON.stringify({ ...att, r2Key: key }), { expirationTtl: 3600 });

  return json(serializeAttachment(att));
}
