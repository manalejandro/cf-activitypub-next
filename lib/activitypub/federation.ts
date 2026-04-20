/**
 * Federation: deliver activities to remote servers and resolve remote actors/objects.
 */

import { signRequest } from "./security";
import type { APActivity, APActor, APObject } from "@/lib/types";

const AP_CONTENT_TYPE = "application/activity+json";
const AP_ACCEPT = 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';
const REQUEST_TIMEOUT_MS = 10_000;

// ─────────────────────────────────────────
// Deliver to a single inbox
// ─────────────────────────────────────────

export async function deliverToInbox(
  inboxUrl: string,
  activity: APActivity,
  senderKeyId: string,
  privateKeyPem: string
): Promise<{ ok: boolean; status: number; error?: string }> {
  const body = JSON.stringify(activity);
  const headers = await signRequest("POST", inboxUrl, body, privateKeyPem, senderKeyId);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(inboxUrl, {
      method: "POST",
      headers: {
        "Content-Type": AP_CONTENT_TYPE,
        Accept: AP_ACCEPT,
        ...headers,
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: 0, error: String(err) };
  }
}

// ─────────────────────────────────────────
// Fan-out delivery to multiple inboxes
// ─────────────────────────────────────────

export async function deliverToInboxes(
  inboxUrls: string[],
  activity: APActivity,
  senderKeyId: string,
  privateKeyPem: string
): Promise<void> {
  // De-duplicate inboxes
  const unique = [...new Set(inboxUrls)];
  await Promise.allSettled(
    unique.map((url) => deliverToInbox(url, activity, senderKeyId, privateKeyPem))
  );
}

// ─────────────────────────────────────────
// Fetch a remote ActivityPub object
// ─────────────────────────────────────────

export async function fetchRemoteObject(
  url: string,
  senderKeyId?: string,
  privateKeyPem?: string
): Promise<APActor | APObject | APActivity | null> {
  const additionalHeaders: Record<string, string> = {};

  if (senderKeyId && privateKeyPem) {
    const signed = await signRequest("GET", url, null, privateKeyPem, senderKeyId);
    Object.assign(additionalHeaders, signed);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: {
        Accept: AP_ACCEPT,
        ...additionalHeaders,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) return null;

    const data = await res.json();
    return data as APActor | APObject | APActivity;
  } catch {
    clearTimeout(timer);
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
        inboxes.push(actor.inbox);
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
    const res = await fetch(url, {
      headers: { Accept: "application/jrd+json, application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json() as { links?: { rel: string; href: string }[] };
    const selfLink = data.links?.find((l) => l.rel === "self");
    return selfLink?.href ?? null;
  } catch {
    return null;
  }
}
