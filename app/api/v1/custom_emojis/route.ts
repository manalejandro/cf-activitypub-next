import { getCloudflareContext } from "@/lib/cf";
import { getAllCustomEmojis } from "@/lib/db";

// GET /api/v1/custom_emojis — fetched by every client when composing; cache in
// KV so a burst of clients doesn't query D1 per request. Emoji changes appear
// within the TTL (admins rarely edit emojis mid-session).
export async function GET(): Promise<Response> {
  const { env } = getCloudflareContext();

  const cacheKey = "custom_emojis:v1";
  const cached = await env.KV.get(cacheKey).catch(() => null);
  if (cached) {
    return new Response(cached, { headers: { "Content-Type": "application/json; charset=utf-8" } });
  }

  const emojis = await getAllCustomEmojis(env.DB);
  const body = JSON.stringify(
    emojis.map((emoji) => ({
      shortcode: emoji.shortcode,
      url: emoji.url,
      static_url: emoji.staticUrl,
      visible_in_picker: emoji.visibleInPicker,
      ...(emoji.category ? { category: emoji.category } : {}),
    }))
  );

  await env.KV.put(cacheKey, body, { expirationTtl: 300 }).catch(() => {});
  return new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8" } });
}