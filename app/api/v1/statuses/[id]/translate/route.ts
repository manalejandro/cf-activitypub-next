import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getObjectById, getActorById } from "@/lib/db";
import { decodeStatusId } from "@/lib/mastodon/statusId";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const { id } = await params;
  const me = await getAuthenticatedActor(request, env.DB);
  if (!me) return unauthorized();
  const obj = await getObjectById(env.DB, decodeStatusId(id, domain));
  if (!obj) return notFound();
  const text = (obj.content ?? "").replace(/<[^>]*>/g, "");
  const targetLang = (await request.json() as { lang?: string }).lang ?? "en";
  const libretranslateUrl = env.LIBRETRANSLATE_URL?.trim();
  let translatedText = text;
  if (libretranslateUrl) {
    try {
      const res = await fetch(libretranslateUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: text, source: "auto", target: targetLang, format: "text" }),
      });
      if (res.ok) {
        const data = await res.json() as { translatedText: string };
        translatedText = data.translatedText;
      }
    } catch { /* fallback to original */ }
  }
  return json({
    id,
    content: translatedText,
    detected_source_language: null,
    provider: { title: "LibreTranslate", domain: libretranslateUrl ? new URL(libretranslateUrl).hostname : null },
  });
}
