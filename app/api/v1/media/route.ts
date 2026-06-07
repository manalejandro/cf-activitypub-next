import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { createAttachment } from "@/lib/db";

// POST /api/v1/media — Upload a media attachment (stored in R2)
export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return json({ error: "multipart/form-data required" }, 422);
  }

  const form = await request.formData();
  const file = form.get("file") as File | null;
  const description = (form.get("description") as string | null) ?? null;
  // UI locale sent by the client to determine auto-description prefix language
  const locale = (form.get("locale") as string | null) ?? "en";

  if (!file || file.size === 0) {
    return json({ error: "file is required" }, 422);
  }

  const ALLOWED_TYPES = [
    "image/jpeg", "image/png", "image/gif", "image/webp",
    "video/mp4", "video/webm", "audio/mpeg", "audio/ogg",
  ];
  if (!ALLOWED_TYPES.includes(file.type)) {
    return json({ error: "Unsupported file type" }, 422);
  }

  const MAX_SIZE = 16 * 1024 * 1024; // 16 MB
  if (file.size > MAX_SIZE) {
    return json({ error: "File too large (max 16 MB)" }, 422);
  }

  // Generate a unique key for R2
  const id = crypto.randomUUID().replace(/-/g, "");
  const ext = file.name.split(".").pop() ?? "bin";
  const key = `media/${actor.username}/${id}.${ext}`;

  const buffer = await file.arrayBuffer();
  // Capture bytes before R2.put in case the runtime detaches the underlying ArrayBuffer
  const imageBytes = [...new Uint8Array(buffer)];

  await env.R2.put(key, buffer, {
    httpMetadata: { contentType: file.type },
    customMetadata: { actorId: actor.id, description: description ?? "" },
  });

  const baseUrl = (env as unknown as Record<string, string>).INSTANCE_URL ?? `https://${new URL(request.url).hostname}`;
  const url = `${baseUrl}/api/media/${key}`;

  // Auto-describe images with Cloudflare Workers AI when no description provided
  let finalDescription = description;
  if (!description && file.type.startsWith("image/") && env.AI) {
    try {
      type ImageToTextResult = { description: string };
      const aiResult = await env.AI.run(
        "@cf/llava-hf/llava-1.5-7b-hf" as Parameters<Ai["run"]>[0],
        {
          image: imageBytes,
          prompt: locale === "es"
            ? "Haz una descripción concisa de esta imagen teniendo en cuenta que la leerán personas con discapacidad visual que necesitan conocer los detalles y el texto escrito si lo tuviera, en español."
            : "Make a concise description of this image taking into account that it will be read by people with visual disabilities who need to know the details and the written text if they have it.",
          max_tokens: 512,
        } as Parameters<Ai["run"]>[1],
      ) as ImageToTextResult;
      const aiText = (aiResult.description ?? "").trim();
      if (aiText) {
        const prefix = locale === "es" ? "Autodescripción: " : "Autodescribe: ";
        finalDescription = prefix + aiText;
      }
    } catch {
      // AI unavailable or model error — leave description as null
    }
  }

  // Persist attachment record (not linked to an object yet; object_id filled when status is posted)
  const att = {
    id,
    objectId: "", // will be updated when attached to a status
    type: file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : "image",
    url,
    remoteUrl: null,
    description: finalDescription,
    blurhash: null,
    width: null,
    height: null,
    fileSize: file.size,
    mimeType: file.type,
    createdAt: new Date().toISOString(),
  };

  // Store in KV temporarily (keyed by attachment id) so statuses route can link it
  await env.KV.put(`pending_media:${id}`, JSON.stringify({ ...att, r2Key: key }), { expirationTtl: 3600 });

  return json({
    id,
    type: att.type,
    url,
    preview_url: url,
    remote_url: null,
    description: finalDescription,
    blurhash: null,
    meta: {},
  }, 200);
}
