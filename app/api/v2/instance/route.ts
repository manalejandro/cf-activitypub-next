import { type NextRequest } from "next/server";
import { getCloudflareContext } from "@/lib/cf";
import { serializeInstanceV2, serializeAccount } from "@/lib/mastodon/serializers";
import { getInstanceContactActor, getInstanceSetting, getInstanceStats } from "@/lib/db";
import { SUPPORTED_LANGUAGE_CODES } from "@/lib/locales/supported";
import { resolveLimits, MASTODON_COMPAT_VERSION } from "@/lib/constants";

// GET /api/v2/instance
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const limits = resolveLimits(env as unknown as Record<string, unknown>);

  // Every client fetches instance info on startup; a burst of logins would run
  // count/contact queries against D1 per request. Cache the serialized payload.
  const cacheKey = "instance:v2";
  const cached = await env.KV.get(cacheKey).catch(() => null);
  if (cached) {
    return new Response(cached, { headers: { "Content-Type": "application/json; charset=utf-8" } });
  }

  const [contactActor, rulesRaw, languagesRaw, stats] = await Promise.all([
    getInstanceContactActor(env.DB),
    getInstanceSetting(env.DB, "rules"),
    getInstanceSetting(env.DB, "languages"),
    getInstanceStats(env.DB, env.KV),
  ]);

  const userCount = stats.userCount;

  const title = env.INSTANCE_TITLE ?? domain;
  const description = env.INSTANCE_DESCRIPTION ?? "An ActivityPub server";
  const version = `${env.INSTANCE_VERSION ?? "0.1.0"} (compatible; Mastodon ${MASTODON_COMPAT_VERSION})`;

  let rules: { id: string; text: string }[] = [];
  try { rules = rulesRaw ? JSON.parse(rulesRaw) : []; } catch { /* ignore */ }
  let languages: string[] = SUPPORTED_LANGUAGE_CODES;
  try {
    const langs = languagesRaw ? JSON.parse(languagesRaw) as { code: string }[] : [];
    if (langs.length > 0) languages = langs.map((l) => l.code);
  } catch { /* ignore */ }

  const payload = serializeInstanceV2(
    domain,
    title,
    description,
    version,
    userCount,
    contactActor ? serializeAccount(contactActor, domain) : null,
    env.VAPID_PUBLIC_KEY,
    languages,
    rules,
    limits
  );

  const body = JSON.stringify(payload);
  await env.KV.put(cacheKey, body, { expirationTtl: 900 }).catch(() => {});
  return new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8" } });
}