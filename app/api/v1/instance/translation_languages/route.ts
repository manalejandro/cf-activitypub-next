import { getCloudflareContext, json } from "@/lib/cf";
import { getInstanceSetting } from "@/lib/db";
import { validateOutboundUrl } from "@/lib/activitypub/federation";
import { SUPPORTED_LANGUAGE_CODES } from "@/lib/locales/supported";

interface LtLanguage {
  code: string;
  name: string;
  targets: string[];
}

/**
 * GET /api/v1/instance/translation_languages
 * Languages available for translation. When LibreTranslate is configured, the
 * list is fetched live from its /languages endpoint; otherwise it falls back to
 * the instance's configured languages.
 */
export async function GET(): Promise<Response> {
  const { env } = getCloudflareContext();

  const ltUrl = env.LIBRETRANSLATE_URL?.trim();
  if (ltUrl) {
    try {
      // LIBRETRANSLATE_URL points at /translate; the languages endpoint lives on
      // the same origin at /languages.
      const base = ltUrl.replace(/\/translate\/?$/, "").replace(/\/$/, "");
      const languagesUrl = `${base}/languages`;
      const val = validateOutboundUrl(languagesUrl);
      if (val.valid) {
        const res = await fetch(languagesUrl, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const langs = await res.json() as LtLanguage[];
          const source = [...new Set(langs.map((l) => l.code))];
          const target = [...new Set(langs.flatMap((l) => l.targets ?? []))];
          if (source.length > 0) {
            return json({ source, target });
          }
        }
      }
    } catch { /* fall through to configured languages */ }
  }

  // Fallback: the instance's configured languages.
  const raw = await getInstanceSetting(env.DB, "languages");
  const codes: string[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { code: string }[];
      if (parsed.length > 0) codes.push(...parsed.map((l) => l.code));
    } catch { /* ignore */ }
  }
  if (codes.length === 0) codes.push(...SUPPORTED_LANGUAGE_CODES);
  return json({ source: codes, target: codes });
}