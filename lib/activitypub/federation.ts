/**
 * Federation: deliver activities to remote servers and resolve remote actors/objects.
 */

import { signRequest } from "./security";
import type { APActivity, APActor, APObject } from "@/lib/types";

const AP_CONTENT_TYPE = "application/activity+json";
const AP_ACCEPT = 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';
const REQUEST_TIMEOUT_MS = 10_000;

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
export async function safeFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<Response | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const validation = validateOutboundUrl(current);
    if (!validation.valid) {
      console.warn(`[federation] Blocked outbound request to ${current}: ${validation.reason}`);
      return null;
    }
    const res = await fetch(current, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res;
      await res.body?.cancel().catch(() => {});
      try {
        current = new URL(location, current).toString();
      } catch {
        return null;
      }
      continue;
    }
    return res;
  }
  console.warn(`[federation] Too many redirects for ${url}`);
  return null;
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
  const headers = await signRequest("POST", inboxUrl, body, privateKeyPem, senderKeyId);

  try {
    const res = await safeFetch(inboxUrl, {
      method: "POST",
      headers: {
        "Content-Type": AP_CONTENT_TYPE,
        Accept: AP_ACCEPT,
        ...headers,
      },
      body,
    });
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

  const additionalHeaders: Record<string, string> = {};

  if (senderKeyId && privateKeyPem) {
    const signed = await signRequest("GET", url, null, privateKeyPem, senderKeyId);
    Object.assign(additionalHeaders, signed);
  }

  try {
    const res = await safeFetch(url, {
      headers: {
        Accept: AP_ACCEPT,
        ...additionalHeaders,
      },
    });
    if (!res?.ok) return null;

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) return null;

    // The timeout signal stays armed while the body is read, so a slow body
    // can't hang the request past REQUEST_TIMEOUT_MS.
    const data = await res.json();
    return data as APActor | APObject | APActivity;
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
    if (!res?.ok) return null;
    const data = await res.json() as { links?: { rel: string; href: string }[] };
    const selfLink = data.links?.find((l) => l.rel === "self");
    return selfLink?.href ?? null;
  } catch {
    return null;
  }
}
