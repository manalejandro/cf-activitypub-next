import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";

interface LibreTranslateRequest {
  q: string;
  source: string;
  target: string;
  format: "html" | "text";
}

interface LibreTranslateResponse {
  translatedText: string;
}

export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  const libretranslateUrl = env.LIBRETRANSLATE_URL?.trim();
  if (!libretranslateUrl) {
    return json({ error: "Translation is not configured on this server" }, 501);
  }

  const body = await request.json() as {
    text: string;
    source_lang?: string;
    target_lang?: string;
  };

  const text = body.text?.trim();
  if (!text) {
    return json({ error: "text is required" }, 400);
  }

  const source = body.source_lang || "auto";
  const target = body.target_lang || "en";

  const ltBody: LibreTranslateRequest = {
    q: text,
    source,
    target,
    format: "html",
  };

  try {
    const res = await fetch(libretranslateUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ltBody),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[translate] LibreTranslate error:", res.status, errText);
      return json({ error: "Translation failed" }, 502);
    }

    const data = await res.json() as LibreTranslateResponse;
    return json({ translatedText: data.translatedText });
  } catch (err) {
    console.error("[translate] Failed to call LibreTranslate:", err);
    return json({ error: "Translation service unreachable" }, 502);
  }
}
