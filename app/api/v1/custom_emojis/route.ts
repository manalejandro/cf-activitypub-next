import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { getAllCustomEmojis } from "@/lib/db";

export async function GET(_request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const emojis = await getAllCustomEmojis(env.DB);
  return json(
    emojis.map((emoji) => ({
      shortcode: emoji.shortcode,
      url: emoji.url,
      static_url: emoji.staticUrl,
      visible_in_picker: emoji.visibleInPicker,
      ...(emoji.category ? { category: emoji.category } : {}),
    }))
  );
}
