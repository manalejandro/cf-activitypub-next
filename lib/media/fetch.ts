/**
 * Shared outbound fetch client for cacheable federated resources.
 *
 * Used by both the R2 media cache (attachments, avatars, headers) and the link
 * preview crawler (HTML pages, oEmbed payloads, preview images): requests go
 * out with the instance bot user agent first and then common browser user
 * agents (some origins block bots outright), and every hop is SSRF-validated
 * by `safeFetch`.
 */

import { safeFetch } from "@/lib/activitypub/federation";

// Bounded body reads live in lib/http.ts (shared with the federation fetchers,
// which cannot import from here without a cycle); re-exported for callers of
// the media client.
export { readBoundedBytes } from "@/lib/http";

export interface FetchWithUserAgentsOptions {
  userAgents: string[];
  accept: string;
  timeoutMs?: number;
  /**
   * Reject responses above this declared size before reading the body. A
   * function receives the response content type, so callers can apply
   * per-type limits (Mastodon: images 16 MiB, video/GIF/audio 99 MiB).
   */
  maxBytes?: number | ((contentType: string) => number);
  /** Content types worth keeping; anything else is a permanent failure. */
  isAcceptableType?: (contentType: string) => boolean;
}

export type FetchWithUserAgentsResult =
  | {
      ok: true;
      response: Response;
      contentType: string;
      declaredLength: number;
      userAgent: string;
    }
  | {
      ok: false;
      error: string;
      /** true when retrying (another user agent or a later attempt) is useless. */
      permanent: boolean;
    };

/**
 * Try each user agent until one gets a 2xx response of an acceptable type.
 * 404/410, unsupported content types and oversized bodies are permanent; any
 * other status (401/403/406/429/451/5xx…) falls through to the next agent.
 */
export async function fetchWithUserAgents(
  url: string,
  options: FetchWithUserAgentsOptions
): Promise<FetchWithUserAgentsResult> {
  let lastError = "unreachable";

  for (const userAgent of options.userAgents) {
    let res: Response | null = null;
    try {
      res = await safeFetch(
        url,
        { headers: { "User-Agent": userAgent, Accept: options.accept } },
        options.timeoutMs
      );
    } catch (err) {
      lastError = String(err);
      continue;
    }
    if (!res) {
      lastError = "unreachable";
      continue;
    }
    if (res.status === 404 || res.status === 410) {
      lastError = `HTTP ${res.status}`;
      await res.body?.cancel().catch(() => {});
      return { ok: false, error: lastError, permanent: true };
    }
    if (!res.ok) {
      lastError = `HTTP ${res.status}`;
      await res.body?.cancel().catch(() => {});
      // 401/403/406/429/451 → the next user agent may be accepted.
      continue;
    }

    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (options.isAcceptableType && !options.isAcceptableType(contentType)) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, error: `Unsupported content type ${contentType || "unknown"}`, permanent: true };
    }
    const declaredLength = Number(res.headers.get("content-length") ?? "0");
    const maxBytes = typeof options.maxBytes === "function" ? options.maxBytes(contentType) : options.maxBytes;
    if (maxBytes && declaredLength > maxBytes) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, error: `Too large (${declaredLength} bytes)`, permanent: true };
    }
    return { ok: true, response: res, contentType, declaredLength, userAgent };
  }

  return { ok: false, error: lastError, permanent: false };
}
