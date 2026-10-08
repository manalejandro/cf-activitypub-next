import { type NextRequest } from "next/server";
import { json } from "@/lib/cf";
import { getAllCustomEmojis, upsertCustomEmoji } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-auth";
import { resolveLimits } from "@/lib/constants";
import { putMediaObject } from "@/lib/media/r2-put";
import { env } from "cloudflare:workers";

// GET /api/admin/emojis — List all custom emoji (including disabled)
export async function GET(request: NextRequest): Promise<Response> {
  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const emojis = await getAllCustomEmojis(env.DB, true);
  return json(emojis);
}

// POST /api/admin/emojis — Upload a new custom emoji
export async function POST(request: NextRequest): Promise<Response> {
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return json({ error: "multipart/form-data required", error_code: "media_error_form" }, 422);
  }

  const form = await request.formData();
  const file = form.get("file") as File | null;
  const shortcode = (form.get("shortcode") as string ?? "").trim().toLowerCase();
  const category = (form.get("category") as string ?? "").trim() || null;

  if (!file || file.size === 0) {
    return json({ error: "file is required", error_code: "media_error_required" }, 422);
  }
  if (!shortcode || !/^[a-zA-Z0-9_]+$/.test(shortcode)) {
    return json({ error: "shortcode must contain only letters, numbers, and underscores", error_code: "emoji_error_shortcode" }, 422);
  }
  if (shortcode.length > limits.maxEmojiShortcodeChars) {
    return json({ error: `shortcode must be ${limits.maxEmojiShortcodeChars} characters or less`, error_code: "emoji_error_shortcode" }, 422);
  }

  const ALLOWED_TYPES = ["image/png", "image/gif", "image/webp"];
  if (!ALLOWED_TYPES.includes(file.type)) {
    return json({ error: "Unsupported file type (use PNG, GIF, or WebP)", error_code: "media_error_type" }, 422);
  }
  if (file.size > 2 * 1024 * 1024) {
    return json({ error: "File too large (max 2 MB)", error_code: "media_error_too_large" }, 422);
  }

  const ext = file.name.split(".").pop() ?? "png";
  const id = crypto.randomUUID().replace(/-/g, "");
  const key = `emoji/${shortcode}/${id}.${ext}`;

  const buffer = await file.arrayBuffer();
  await putMediaObject(env.R2, key, buffer, {
    httpMetadata: { contentType: file.type },
  });

  const baseUrl = (env as unknown as Record<string, string>).INSTANCE_URL ?? `https://${new URL(request.url).hostname}`;
  const url = `${baseUrl}/api/media/${key}`;
  const staticUrl = url; // Same image for now; could generate static PNG later

  await upsertCustomEmoji(env.DB, {
    id,
    shortcode,
    url,
    staticUrl,
    category,
    visibleInPicker: true,
    domain: null,
    actorId: null,
  });

  await env.KV.delete("custom_emojis:v1").catch(() => {});
  return json({ id, shortcode, url, static_url: staticUrl, category, visible_in_picker: true }, 201);
}
