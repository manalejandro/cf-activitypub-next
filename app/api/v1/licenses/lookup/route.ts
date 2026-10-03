import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { cachedMediaUrl, enqueueMediaCache, getLicenseByUrl, mediaCacheId } from "@/lib/db";
import { licenseIconsForUrl, licenseOrigin } from "@/lib/licenses";
import { validateOutboundUrl } from "@/lib/activitypub/federation";
import { fetchWithUserAgents, readBoundedBytes } from "@/lib/media/fetch";
import { resolveLimits } from "@/lib/constants";

/**
 * GET /api/v1/licenses/lookup?url=… — resolve a license that is not in this
 * instance's catalogue (FEP-6757: "consult the origin instance").
 *
 * Our own software serves the catalogue at `/api/v1/licenses`, so asking the
 * origin instance gives the real name and icon of a custom license instead of
 * just a URI. The answer is cached in KV; when nothing is found the client
 * falls back to the letters of the license id and links to the origin.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const url = request.nextUrl.searchParams.get("url") ?? "";
  if (!url || !validateOutboundUrl(url).valid) return json(null);

  const local = await getLicenseByUrl(env.DB, url);
  if (local) {
    return json({
      id: local.id,
      name: local.name,
      url: local.url,
      icon: (await cachedMediaUrl(env.DB, local.icon)) ?? local.icon,
      badges: licenseIconsForUrl(local.url),
    });
  }

  const origin = licenseOrigin(url);
  if (!origin) return json(null);

  const cacheKey = `license:lookup:${await mediaCacheId(url)}`;
  const cached = await env.KV.get(cacheKey).catch(() => null);
  if (cached) {
    try {
      return json(JSON.parse(cached));
    } catch { /* refetch below */ }
  }

  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  let found: { id: string; name: string; url: string; icon: string; badges: string } | null = null;
  try {
    const fetched = await fetchWithUserAgents(`${origin}/api/v1/licenses`, {
      userAgents: limits.mediaCacheUserAgents,
      accept: "application/json",
      timeoutMs: 6000,
      maxBytes: 512 * 1024,
    });
    if (fetched.ok) {
      const bytes = await readBoundedBytes(fetched.response, 512 * 1024);
      const list = bytes
        ? JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(bytes)) as unknown
        : null;
      const hit = Array.isArray(list)
        ? (list as { id?: unknown; name?: unknown; url?: unknown; icon?: unknown }[]).find((l) => l?.url === url)
        : null;
      if (hit && typeof hit.id === "string" && typeof hit.name === "string") {
        found = {
          id: hit.id,
          name: hit.name,
          url,
          icon: typeof hit.icon === "string" ? hit.icon : "",
          badges: licenseIconsForUrl(url),
        };
      }
    }
  } catch { /* unreachable origin: fall back to the URI */ }

  if (found) {
    // Put the icon in R2 too (media cache) and serve the copy when it is ready:
    // the answer is then cached for a week, otherwise only an hour so the next
    // lookup can pick the cached URL up.
    let ttl = 3600;
    if (found.icon) {
      await enqueueMediaCache(env.DB, found.icon, "license", found.id).catch(() => {});
      const cached = await cachedMediaUrl(env.DB, found.icon);
      if (cached) {
        found.icon = cached;
        ttl = 7 * 24 * 3600;
      }
    } else {
      ttl = 7 * 24 * 3600;
    }
    await env.KV.put(cacheKey, JSON.stringify(found), { expirationTtl: ttl }).catch(() => {});
  }
  return json(found);
}
