import { type NextRequest } from "next/server";
import { json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeAttachment } from "@/lib/mastodon/serializers";
import { localAttachmentType, mediaLimitFor, resolveLimits, SUPPORTED_MEDIA_MIME_TYPES } from "@/lib/constants";
import { putMediaObject } from "@/lib/media/r2-put";
import { safeUploadName } from "@/lib/media/filename";
import { getAccountMediaUsage } from "@/lib/media/quota";
import { atomicRateLimit } from "@/lib/rate-limit";
import { env } from "cloudflare:workers";

export async function POST(request: NextRequest): Promise<Response> {
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const me = await getAuthenticatedActor(request, env.DB);
  if (!me) return unauthorized();
  // Uploads write to R2: bound the per-account rate (atomic DO counter when
  // configured).
  const { allowed: canUpload } = await atomicRateLimit(env, `upload:${me.id}`, 30, 60);
  if (!canUpload) {
    return json({ error: "Too many uploads. Please try again later.", error_code: "media_error_rate_limited" }, 429);
  }
  // Reject an oversized body before parsing it: formData() buffers the whole
  // upload in the isolate, and the per-type caps below only fire afterwards.
  const maxUploadBytes = Math.max(limits.maxImageSize, limits.maxVideoSize, limits.maxDocumentSize) + 1024 * 1024;
  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxUploadBytes) {
    return json({ error: "File too large", error_code: "media_error_too_large" }, 413);
  }
  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  if (!file) return json({ error: "File is required" }, 400);
  if (!SUPPORTED_MEDIA_MIME_TYPES.includes(file.type)) {
    return json({ error: "Unsupported media type", error_code: "media_error_type" }, 400);
  }
  const maxSize = mediaLimitFor(file.type, limits);
  if (file.size > maxSize) {
    return json(
      { error: `File too large (max ${Math.floor(maxSize / (1024 * 1024))} MB)`, error_code: "media_error_too_large" },
      413
    );
  }
  // Per-account storage quota (UPLOAD_QUOTA_BYTES, 0 disables).
  if (limits.uploadQuotaBytes > 0) {
    const usage = await getAccountMediaUsage(env.DB, me.id);
    if (usage + file.size > limits.uploadQuotaBytes) {
      return json({ error: "Storage quota exceeded", error_code: "media_error_quota" }, 422);
    }
  }
  const description = (formData.get("description") as string | null) ?? null;
  if (description && description.length > limits.maxAltTextChars) {
    return json({ error: `description is too long (max ${limits.maxAltTextChars} chars)` }, 422);
  }
  const id = crypto.randomUUID();
  // The file name is client-controlled and becomes part of the R2 key (and of
  // the served URL): keep it a safe single path segment.
  const key = `media/${me.username}/${id}-${safeUploadName(file.name)}`;
  const buffer = await file.arrayBuffer();
  await putMediaObject(env.R2, key, buffer, { httpMetadata: { contentType: file.type } });
  const url = `https://${new URL(request.url).hostname}/api/media/${key}`;
  const att = {
    id,
    objectId: "",
    type: localAttachmentType(file.type),
    url,
    remoteUrl: null,
    description,
    blurhash: null,
    width: null,
    height: null,
    fileSize: file.size,
    mimeType: file.type,
    sensitive: false,
    createdAt: new Date().toISOString(),
  };
  await env.KV.put(`pending_media:${id}`, JSON.stringify({ ...att, r2Key: key, actorId: me.id }), { expirationTtl: 3600 });

  return json(serializeAttachment(att));
}
