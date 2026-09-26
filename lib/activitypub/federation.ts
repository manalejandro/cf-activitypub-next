/**
 * Federation: deliver activities to remote servers and resolve remote actors/objects.
 */

import { signRequest, signRequestRfc9421 } from "./security";
import { discardBody } from "@/lib/http";
import { getCloudflareContext } from "@/lib/cf";
import type { APActivity, APActor, APObject } from "@/lib/types";

const AP_CONTENT_TYPE = "application/activity+json";
const AP_ACCEPT = 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Local actor signing outbound fetches when the caller has no key at hand.
 * Authorized-fetch instances (mastodon.social) answer unsigned actor/object
 * requests with 401 "Request not signed". Prefer the reserved instance actor,
 * cached for the isolate's lifetime (keys change rarely).
 */
let fetchSigner: { id: string; privateKeyPem: string } | null | undefined;

async function getFetchSigner(): Promise<{ id: string; privateKeyPem: string } | null> {
  if (fetchSigner !== undefined) return fetchSigner;
  try {
    const { env } = getCloudflareContext();
    const row = await env.DB
      .prepare(
        `SELECT id, private_key_pem FROM actors
         WHERE is_local = 1 AND private_key_pem IS NOT NULL AND suspended = 0
         ORDER BY COALESCE(reserved, 0) DESC LIMIT 1`
      )
      .first<{ id: string; private_key_pem: string }>();
    fetchSigner = row?.private_key_pem ? { id: row.id, privateKeyPem: row.private_key_pem } : null;
  } catch {
    fetchSigner = null;
  }
  return fetchSigner;
}

/** Signature headers for an outbound GET, falling back to the instance signer. */
export async function signedGetHeaders(
  url: string,
  keyId?: string,
  privateKeyPem?: string
): Promise<Record<string, string>> {
  let kid = keyId;
  let pem = privateKeyPem;
  if (!kid || !pem) {
    const signer = await getFetchSigner();
    if (!signer) return {};
    kid = `${signer.id}#main-key`;
    pem = signer.privateKeyPem;
  }
  if (!kid.includes("#")) kid = `${kid}#main-key`;
  try {
    return await signRequest("GET", url, null, pem, kid);
  } catch {
    return {};
  }
}

/** RFC 9421 counterpart of `signedGetHeaders` for the fallback retry. */
export async function signedGetHeadersRfc9421(
  url: string,
  keyId?: string,
  privateKeyPem?: string
): Promise<Record<string, string>> {
  let kid = keyId;
  let pem = privateKeyPem;
  if (!kid || !pem) {
    const signer = await getFetchSigner();
    if (!signer) return {};
    kid = `${signer.id}#main-key`;
    pem = signer.privateKeyPem;
  }
  if (!kid.includes("#")) kid = `${kid}#main-key`;
  try {
    return await signRequestRfc9421("GET", url, null, pem, kid);
  } catch {
    return {};
  }
}

const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,                              // link-local incl. cloud metadata 169.254.169.254
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64.0.0/10
  /^0\./,                                     // "this network" 0.0.0.0/8
  /^(22[4-9]|23\d|24\d|25[0-5])\./,           // multicast + reserved 224.0.0.0/4
  /^::1$/,
  /^::$/,
  /^fc00:/i,
  /^fd[0-9a-f]{2}:/i,                         // unique local fc00::/7
  /^fe80:/i,
  // IPv4-mapped IPv6 forms of the ranges above (dotted and normalized hex).
  /^::ffff:/i,
];

const PRIVATE_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

/**
 * Validates that a URL is safe for outbound HTTP requests.
 * Rejects non-HTTPS, private/reserved IPs, localhost and internal DNS names.
 * Defense-in-depth against SSRF via injected ActivityPub actor fields.
 * Note: this cannot resolve DNS, so a public hostname pointing at a private
 * address is out of scope for this check.
 */
export function validateOutboundUrl(url: string): { valid: boolean; reason?: string } {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      return { valid: false, reason: "Only HTTPS URLs are allowed" };
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (hostname === "localhost" || PRIVATE_HOST_SUFFIXES.some((s) => hostname.endsWith(s))) {
      return { valid: false, reason: "Localhost/internal hostnames are not allowed" };
    }
    if (PRIVATE_IP_RANGES.some((re) => re.test(hostname))) {
      return { valid: false, reason: "Private IP ranges are not allowed" };
    }
    return { valid: true };
  } catch {
    return { valid: false, reason: "Invalid URL format" };
  }
}

// ─────────────────────────────────────────
// SSRF-safe fetch
// ─────────────────────────────────────────

const MAX_REDIRECTS = 3;

/**
 * Fetch wrapper that re-validates every hop (initial URL and each redirect
 * target) with validateOutboundUrl and bounds the whole exchange with a
 * timeout. Redirects are followed manually because `fetch` would otherwise
 * follow a `Location` into private space without re-validation.
 */
export interface TrackedFetchResult {
  res: Response | null;
  /** Final URL after redirects (the requested URL when there was none). */
  finalUrl: string;
}

/**
 * `safeFetch` variant that reports the final URL so callers can detect
 * cross-host redirects (instance moves) instead of silently following them.
 */
export async function safeFetchTracked(
  url: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<TrackedFetchResult> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const validation = validateOutboundUrl(current);
    if (!validation.valid) {
      console.warn(`[federation] Blocked outbound request to ${current}: ${validation.reason}`);
      return { res: null, finalUrl: current };
    }
    const res = await fetch(current, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { res, finalUrl: current };
      await res.body?.cancel().catch(() => {});
      try {
        current = new URL(location, current).toString();
      } catch {
        return { res: null, finalUrl: current };
      }
      continue;
    }
    if (!res.ok) {
      // Every caller treats non-2xx as a failure and only inspects the status,
      // never the body. Release it here so an unread error response can never
      // stall the runtime's in-flight fetch pool ("A stalled HTTP response was
      // canceled to prevent deadlock").
      await res.body?.cancel().catch(() => {});
    }
    return { res, finalUrl: current };
  }
  console.warn(`[federation] Too many redirects for ${url}`);
  return { res: null, finalUrl: current };
}

export async function safeFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<Response | null> {
  return (await safeFetchTracked(url, init, timeoutMs)).res;
}

/**
 * POST an activity to an inbox. Signs with draft-cavage first and retries with
 * RFC 9421 (HTTP Message Signatures) when the receiver answers 400/401 — the
 * same "double-knock" Mastodon 4.7+ performs, so receivers that only verify
 * HTTP Message Signatures keep working.
 */
export async function postToInboxSigned(
  inboxUrl: string,
  body: string,
  keyId: string,
  privateKeyPem: string,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<Response | null> {
  const baseHeaders = { "Content-Type": AP_CONTENT_TYPE, Accept: AP_ACCEPT };
  let res = await safeFetch(inboxUrl, {
    method: "POST",
    headers: { ...baseHeaders, ...(await signRequest("POST", inboxUrl, body, privateKeyPem, keyId)) },
    body,
  }, timeoutMs);

  if (res && (res.status === 400 || res.status === 401)) {
    await res.body?.cancel().catch(() => {});
    res = await safeFetch(inboxUrl, {
      method: "POST",
      headers: { ...baseHeaders, ...(await signRequestRfc9421("POST", inboxUrl, body, privateKeyPem, keyId)) },
      body,
    }, timeoutMs);
  }
  return res;
}

// ─────────────────────────────────────────
// Deliver to a single inbox
// ─────────────────────────────────────────

export async function deliverToInbox(
  inboxUrl: string,
  activity: APActivity,
  senderKeyId: string,
  privateKeyPem: string
): Promise<{ ok: boolean; status: number; error?: string }> {
  const validation = validateOutboundUrl(inboxUrl);
  if (!validation.valid) {
    console.warn(`[federation] Blocked delivery to ${inboxUrl}: ${validation.reason}`);
    return { ok: false, status: 0, error: validation.reason };
  }

  const body = JSON.stringify(activity);

  try {
    const res = await postToInboxSigned(inboxUrl, body, senderKeyId, privateKeyPem);
    if (!res) return { ok: false, status: 0, error: "Blocked or unreachable" };
    // We only care about the status. Cancel the body so the connection is
    // released — delivering to many inboxes in parallel without reading the
    // responses would stall and trip Cloudflare's deadlock protection.
    await res.body?.cancel().catch(() => {});
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}

// ─────────────────────────────────────────
// Fetch a remote ActivityPub object
// ─────────────────────────────────────────

export async function fetchRemoteObject(
  url: string,
  senderKeyId?: string,
  privateKeyPem?: string
): Promise<APActor | APObject | APActivity | null> {
  const validation = validateOutboundUrl(url);
  if (!validation.valid) {
    console.warn(`[federation] Blocked fetch from ${url}: ${validation.reason}`);
    return null;
  }

  // Always sign: public resources ignore an unknown signature, while
  // authorized-fetch instances require one.
  const additionalHeaders = await signedGetHeaders(url, senderKeyId, privateKeyPem);

  try {
    let res = await safeFetch(url, {
      headers: {
        Accept: AP_ACCEPT,
        ...additionalHeaders,
      },
    });
    // Receivers that verify HTTP Message Signatures only answer 400/401 to a
    // draft-cavage signature: retry with RFC 9421 (Mastodon's double-knock).
    if (res && (res.status === 400 || res.status === 401)) {
      await res.body?.cancel().catch(() => {});
      res = await safeFetch(url, {
        headers: {
          Accept: AP_ACCEPT,
          ...(await signedGetHeadersRfc9421(url, senderKeyId, privateKeyPem)),
        },
      });
    }
    if (!res?.ok) {
      await discardBody(res);
      return null;
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      await discardBody(res);
      return null;
    }

    // The timeout signal stays armed while the body is read, so a slow body
    // can't hang the request past REQUEST_TIMEOUT_MS. Read as text first and
    // cap the size: res.json() on a malicious multi-hundred-MB body would
    // exhaust the Worker's memory before any check could run.
    const text = await res.text();
    if (!text || text.length > 2_000_000) return null;
    try {
      return JSON.parse(text) as APActor | APObject | APActivity;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────
// Collect all follower inboxes for fan-out
// ─────────────────────────────────────────

export async function collectFollowerInboxes(
  followerIds: string[],
  fetchActor: (id: string) => Promise<APActor | null>
): Promise<string[]> {
  const inboxes: string[] = [];
  const sharedInboxes = new Set<string>();

  await Promise.allSettled(
    followerIds.map(async (id) => {
      const actor = await fetchActor(id);
      if (!actor) return;
      const shared = actor.endpoints?.sharedInbox;
      if (shared) {
        if (!sharedInboxes.has(shared)) {
          sharedInboxes.add(shared);
          inboxes.push(shared);
        }
      } else {
        // Fall back to <actorId>/inbox, handling actors whose id ends with '/'
        const base = actor.id.endsWith('/') ? actor.id.slice(0, -1) : actor.id;
        const inbox = actor.inbox ?? `${base}/inbox`;
        if (inbox) inboxes.push(inbox);
      }
    })
  );

  return inboxes;
}

// ─────────────────────────────────────────
// WebFinger resolution
// ─────────────────────────────────────────

export async function resolveWebFinger(
  acct: string
): Promise<string | null> {
  // acct can be "user@domain" or "@user@domain"
  const normalized = acct.replace(/^@/, "");
  const [, domain] = normalized.split("@");
  if (!domain) return null;

  try {
    const url = `https://${domain}/.well-known/webfinger?resource=acct:${normalized}`;
    const res = await safeFetch(url, {
      headers: { Accept: "application/jrd+json, application/json" },
    }, 5000);
    if (!res?.ok) {
      await discardBody(res);
      return null;
    }
    const data = await res.json() as { links?: { rel: string; href: string }[] };
    const selfLink = data.links?.find((l) => l.rel === "self");
    return selfLink?.href ?? null;
  } catch {
    return null;
  }
}
