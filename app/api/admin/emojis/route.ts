import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { getAllCustomEmojis, upsertCustomEmoji } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-auth";
import { resolveLimits } from "@/lib/constants";

// GET /api/admin/emojis — List all custom emoji (including disabled)
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const emojis = await getAllCustomEmojis(env.DB, true);
  return json(emojis);
}

// POST /api/admin/emojis — Upload a new custom emoji
export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return json({ error: "multipart/form-data required" }, 422);
  }

  const form = await request.formData();
  const file = form.get("file") as File | null;
  const shortcode = (form.get("shortcode") as string ?? "").trim().toLowerCase();
  const category = (form.get("category") as string ?? "").trim() || null;

  if (!file || file.size === 0) {
    return json({ error: "file is required" }, 422);
  }
  if (!shortcode || !/^[a-zA-Z0-9_]+$/.test(shortcode)) {
    return json({ error: "shortcode must contain only letters, numbers, and underscores" }, 422);
  }
  if (shortcode.length > limits.maxEmojiShortcodeChars) {
    return json({ error: `shortcode must be ${limits.maxEmojiShortcodeChars} characters or less` }, 422);
  }

  const ALLOWED_TYPES = ["image/png", "image/gif", "image/webp"];
  if (!ALLOWED_TYPES.includes(file.type)) {
    return json({ error: "Unsupported file type (use PNG, GIF, or WebP)" }, 422);
  }
  if (file.size > 2 * 1024 * 1024) {
    return json({ error: "File too large (max 2 MB)" }, 422);
  }

  const ext = file.name.split(".").pop() ?? "png";
  const id = crypto.randomUUID().replace(/-/g, "");
  const key = `emoji/${shortcode}/${id}.${ext}`;

  const buffer = await file.arrayBuffer();
  await env.R2.put(key, buffer, {
    httpMetadata: { contentType: file.type },
  });

  const baseUrl = (env as unknown as Record<string, string>).INSTANCE_URL ?? `http://localhost:3000`;
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

  return json({ id, shortcode, url, static_url: staticUrl, category, visible_in_picker: true }, 201);
}
