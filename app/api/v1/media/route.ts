import { type NextRequest } from "next/server";
import { json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { chargeGlobalAI, AI_UNITS_VISION } from "@/lib/moderation/budget";
import { localAttachmentType, mediaLimitFor, resolveLimits, SUPPORTED_MEDIA_MIME_TYPES } from "@/lib/constants";
import { putMediaObject } from "@/lib/media/r2-put";
import { safeUploadExt } from "@/lib/media/filename";
import { getAccountMediaUsage } from "@/lib/media/quota";
import { atomicRateLimit } from "@/lib/rate-limit";
import { env } from "cloudflare:workers";

// POST /api/v1/media — Upload a media attachment (stored in R2)
export async function POST(request: NextRequest): Promise<Response> {
  const limits = resolveLimits(env as unknown as Record<string, unknown>);

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  // Uploads write to R2 and may trigger an AI vision call: bound the per-account
  // rate (atomic DO counter when configured).
  const { allowed: canUpload } = await atomicRateLimit(env, `upload:${actor.id}`, 30, 60);
  if (!canUpload) {
    return json({ error: "Too many uploads. Please try again later.", error_code: "media_error_rate_limited" }, 429);
  }

  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return json({ error: "multipart/form-data required", error_code: "media_error_form" }, 422);
  }

  // Reject an oversized body before parsing it: formData() buffers the whole
  // upload in the isolate, and the per-type caps below only fire afterwards.
  const maxUploadBytes = Math.max(limits.maxImageSize, limits.maxVideoSize, limits.maxDocumentSize) + 1024 * 1024;
  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxUploadBytes) {
    return json({ error: "File too large", error_code: "media_error_too_large" }, 413);
  }

  const form = await request.formData();
  const file = form.get("file") as File | null;
  const description = (form.get("description") as string | null) ?? null;
  if (description && description.length > limits.maxAltTextChars) {
    return json({ error: `description is too long (max ${limits.maxAltTextChars} chars)`, error_code: "media_error_description" }, 422);
  }
  const sensitive = form.get("sensitive") === "true";
  // UI locale sent by the client to determine auto-description prefix language
  const locale = (form.get("locale") as string | null) ?? "en";

  if (!file || file.size === 0) {
    return json({ error: "file is required", error_code: "media_error_required" }, 422);
  }

  if (!SUPPORTED_MEDIA_MIME_TYPES.includes(file.type)) {
    return json({ error: "Unsupported file type", error_code: "media_error_type" }, 422);
  }

  // Per-type caps: images (and audio) the image limit, video the video one and
  // documents their own — a 40 MB video used to be rejected by the image limit.
  const MAX_SIZE = mediaLimitFor(file.type, limits);
  if (file.size > MAX_SIZE) {
    return json(
      { error: `File too large (max ${Math.floor(MAX_SIZE / (1024 * 1024))} MB)`, error_code: "media_error_too_large" },
      422
    );
  }

  // Per-account storage quota (UPLOAD_QUOTA_BYTES, 0 disables).
  if (limits.uploadQuotaBytes > 0) {
    const usage = await getAccountMediaUsage(env.DB, actor.id);
    if (usage + file.size > limits.uploadQuotaBytes) {
      return json({ error: "Storage quota exceeded", error_code: "media_error_quota" }, 422);
    }
  }

  // Generate a unique key for R2 (the extension is client-controlled: keep it
  // alphanumeric and bounded so the key stays a well-behaved URL path).
  const id = crypto.randomUUID().replace(/-/g, "");
  const ext = safeUploadExt(file.name);
  const key = `media/${actor.username}/${id}.${ext}`;

  const buffer = await file.arrayBuffer();

  await putMediaObject(env.R2, key, buffer, {
    httpMetadata: { contentType: file.type },
    customMetadata: { actorId: actor.id, description: description ?? "" },
  });

  const baseUrl = (env as unknown as Record<string, string>).INSTANCE_URL ?? `https://${new URL(request.url).hostname}`;
  const url = `${baseUrl}/api/media/${key}`;

  // Auto-describe images with Cloudflare Workers AI when no description provided
  let finalDescription = description;
  if (
    !description &&
    file.type.startsWith("image/") &&
    limits.maxVisionInputBytes > 0 &&
    file.size <= limits.maxVisionInputBytes &&
    env.AI &&
    (await chargeGlobalAI(env, AI_UNITS_VISION))
  ) {
    try {
      // The vision model's documented input is a `number[]` (one element per
      // byte): passing a bare Uint8Array serializes malformed and the model
      // hallucinates a description instead of seeing the image. The spread is
      // bounded by AI_VISION_MAX_BYTES (a ~99 MB upload spread into array
      // elements OOMs the isolate, which is why the cap exists); the blob is
      // re-read because R2.put may detach the first buffer.
      const imageBytes = [...new Uint8Array(await file.arrayBuffer())];
      const aiResult = await env.AI.run(
        "@cf/meta/llama-3.2-11b-vision-instruct" as Parameters<Ai["run"]>[0],
        {
          image: imageBytes,
          prompt: locale === "es"
            ? "Describe esta imagen de forma clara y concisa para personas con discapacidad visual. Menciona el tema principal, personas, objetos, acciones, colores relevantes y cualquier texto visible. Responde siempre en español."
            : "Describe this image clearly and concisely for people with visual disabilities. Mention the main subject, people, objects, actions, relevant colors, and any visible text.",
          max_tokens: 768,
        } as Parameters<Ai["run"]>[1],
      ) as { response?: string; description?: string };
      const aiText = (aiResult.response ?? aiResult.description ?? "").trim();
      if (aiText) {
        finalDescription = aiText;
      }
    } catch {
      // AI unavailable or model error — leave description as null
    }
  }

  // Persist attachment record (not linked to an object yet; object_id filled when status is posted)
  const att = {
    id,
    objectId: "", // will be updated when attached to a status
    type: localAttachmentType(file.type),
    url,
    remoteUrl: null,
    description: finalDescription,
    blurhash: null,
    width: null,
    height: null,
    fileSize: file.size,
    mimeType: file.type,
    sensitive,
    createdAt: new Date().toISOString(),
  };

  // Store in KV temporarily (keyed by attachment id) so statuses route can link it
  await env.KV.put(`pending_media:${id}`, JSON.stringify({ ...att, r2Key: key, actorId: actor.id }), { expirationTtl: 3600 });

  return json({
    id,
    type: att.type,
    url,
    preview_url: url,
    remote_url: null,
    description: finalDescription,
    blurhash: null,
    sensitive,
    meta: {},
  }, 200);
}
