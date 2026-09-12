/**
 * Federation engine — instance registry, NodeInfo metadata and availability.
 *
 * Adapts Mastodon's model to Cloudflare Workers:
 *  - `ActivityPub::DeliveryWorker` retries 16× with quartic backoff + jitter and
 *    skips hosts marked unavailable (implemented in src/worker.ts + the helpers
 *    here).
 *  - `DeliveryFailureTracker` marks a host unavailable after failures on 7
 *    distinct UTC days; any success (outbound delivery or a signed inbound
 *    activity) clears it.
 *  - `Scheduler::InstanceRefreshScheduler` refreshes instance metadata hourly;
 *    here a cron picks due instances (NodeInfo, Mastodon v2 fallback) and
 *    dormant ones lose their cached metadata (expiry).
 */

import type { D1Database } from "@cloudflare/workers-types";
import { safeFetch, validateOutboundUrl, fetchRemoteObject } from "@/lib/activitypub/federation";
import {
  getInstance,
  getActorIdsByDomain,
  deleteRemoteActorData,
  recordInstanceFailure,
  recordInstanceSuccess,
  recordInstanceRefreshFailure,
  touchInstanceSeen,
  upsertInstanceMetadata,
  upsertRemoteActor,
  type InstanceMetadataPatch,
} from "@/lib/db";
import type { APActor } from "@/lib/types";
import { INSTANCE_FAILURE_DAYS } from "@/lib/constants";

/** Minimal KV surface (the generated CloudflareEnv type varies across files). */
export interface InstanceKV {
  get(key: string): Promise<string | null>;
  put?(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete?(key: string): Promise<void>;
}

const DOWN_MARKER_TTL_SECONDS = 3_600;

export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let host = input.trim().toLowerCase();
  if (!host) return null;
  try {
    if (host.includes("/") || host.includes(":")) {
      host = new URL(host.includes("://") ? host : `https://${host}`).hostname;
    }
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "");
  if (host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || !host.includes(".")) return null;
  return host;
}

export function instanceDownKey(domain: string): string {
  return `inst:down:${domain.toLowerCase()}`;
}

/** Admin "suspended" marker: keep the record but stop outbound delivery. */
export function instancePausedKey(domain: string): string {
  return `inst:paused:${domain.toLowerCase()}`;
}

export async function isInstancePaused(kv: InstanceKV | null | undefined, domain: string): Promise<boolean> {
  if (!kv) return false;
  try {
    return Boolean(await kv.get(instancePausedKey(domain)));
  } catch {
    return false;
  }
}

/** Set/clear the admin-suspended delivery marker (1-year TTL while paused). */
export async function setInstancePausedMarker(
  kv: InstanceKV | null | undefined,
  domain: string,
  paused: boolean
): Promise<void> {
  if (!kv) return;
  try {
    if (paused) await kv.put?.(instancePausedKey(domain), "1", { expirationTtl: 31_536_000 });
    else await kv.delete?.(instancePausedKey(domain));
  } catch { /* best-effort */ }
}

export async function isInstanceUnavailable(kv: InstanceKV | null | undefined, domain: string): Promise<boolean> {
  if (!kv) return false;
  try {
    return Boolean(await kv.get(instanceDownKey(domain)));
  } catch {
    return false;
  }
}

/** Mastodon's quartic retry schedule (`(count**4) + 15` + jitter), capped at 24h. */
export function deliveryRetryDelay(attempts: number, rand: () => number = Math.random): number {
  const count = Math.max(1, Math.floor(attempts));
  const base = Math.pow(count, 4) + 15;
  const jitter = rand() * 0.5 * base;
  return Math.min(Math.round(base + jitter), 86_400);
}

/** Parse an HTTP `Retry-After` header (seconds or HTTP date), capped at 24h. */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.round(seconds), 86_400);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(0, Math.round((date - Date.now()) / 1000)), 86_400);
}

export interface InstanceMetadata {
  software: string | null;
  version: string | null;
  title: string | null;
  description: string | null;
  openRegistrations: boolean | null;
  languages: string[];
}

async function fetchJson(url: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  try {
    const res = await safeFetch(url, { headers: { Accept: "application/json" } }, timeoutMs);
    if (!res || !res.ok) return null;
    const text = await res.text().catch(() => "");
    if (!text || text.length > 512 * 1024) return null;
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    // Timeout, DNS failure, TLS error, non-JSON body… all mean "no metadata".
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function parseNodeInfo(info: Record<string, unknown>): InstanceMetadata {
  const software = (info.software ?? {}) as Record<string, unknown>;
  const metadata = (info.metadata ?? {}) as Record<string, unknown>;
  const languages = Array.isArray(metadata.languages)
    ? (metadata.languages as unknown[]).filter((l): l is string => typeof l === "string")
    : [];
  return {
    software: str(software.name)?.toLowerCase() ?? null,
    version: str(software.version),
    title: str(metadata.nodeName) ?? str(metadata.name),
    description: str(metadata.nodeDescription) ?? str(metadata.description),
    openRegistrations: typeof info.openRegistrations === "boolean" ? info.openRegistrations : null,
    languages,
  };
}

/** Mastodon-compatible fallback for instances that do not serve NodeInfo. */
function parseMastodonInstance(info: Record<string, unknown>): InstanceMetadata {
  const software = (info.software ?? {}) as Record<string, unknown>;
  const registrations = (info.registrations ?? {}) as Record<string, unknown>;
  return {
    software: str(software.name)?.toLowerCase() ?? "mastodon",
    version: str(software.version),
    title: str(info.title),
    description: str(info.short_description) ?? str(info.description),
    openRegistrations: typeof registrations.enabled === "boolean" ? registrations.enabled : null,
    languages: Array.isArray(info.languages)
      ? (info.languages as unknown[]).filter((l): l is string => typeof l === "string")
      : [],
  };
}

/**
 * Fetch instance metadata: `/.well-known/nodeinfo` (2.1 → 2.0 → 1.0), falling
 * back to Mastodon's `/api/v2/instance`. Never throws; returns null on failure.
 */
export async function fetchInstanceMetadata(
  domain: string,
  timeoutMs = 8_000
): Promise<InstanceMetadata | null> {
  const host = normalizeDomain(domain);
  if (!host) return null;

  const wellKnown = await fetchJson(`https://${host}/.well-known/nodeinfo`, timeoutMs);
  const links = Array.isArray(wellKnown?.links) ? (wellKnown!.links as unknown[]) : [];
  const pick = (rel: string) =>
    links.find((l): l is { rel: string; href: string } => {
      if (!l || typeof l !== "object") return false;
      const link = l as { rel?: unknown; href?: unknown };
      return link.rel === rel && typeof link.href === "string";
    });
  const link =
    pick("http://nodeinfo.diaspora.software/ns/schema/2.1") ??
    pick("http://nodeinfo.diaspora.software/ns/schema/2.0") ??
    pick("http://nodeinfo.diaspora.software/ns/schema/1.0");

  if (link) {
    const validation = validateOutboundUrl(link.href);
    if (validation.valid) {
      const info = await fetchJson(link.href, timeoutMs);
      if (info) return parseNodeInfo(info);
    }
  }

  const mastodon = await fetchJson(`https://${host}/api/v2/instance`, timeoutMs);
  return mastodon ? parseMastodonInstance(mastodon) : null;
}

function nextRefreshSuccessAt(refreshDays: number, now = new Date()): string {
  return new Date(now.getTime() + refreshDays * 86_400_000).toISOString();
}

function nextRefreshFailureAt(failures: number, now = new Date()): string {
  const hours = Math.min(6 * Math.max(1, failures), 24);
  return new Date(now.getTime() + hours * 3_600_000).toISOString();
}

/** First contact: schedule a staggered metadata refresh (spreads the cron load). */
export function staggerRefreshAt(now = new Date()): string {
  return new Date(now.getTime() + Math.floor(Math.random() * 3_600_000)).toISOString();
}

export interface RefreshResult {
  ok: boolean;
  reason?: "invalid" | "locked" | "not-due" | "unreachable";
  metadata?: InstanceMetadata;
}

/**
 * Refresh one instance's metadata (KV-locked so concurrent cron ticks and
 * admin refreshes don't double-fetch). Successful fetches reschedule after
 * `refreshDays`; failures back off 6h × failures (cap 24h).
 */
export async function refreshInstance(
  db: D1Database,
  kv: InstanceKV | null | undefined,
  domain: string,
  opts: { force?: boolean; refreshDays?: number; timeoutMs?: number } = {}
): Promise<RefreshResult> {
  const host = normalizeDomain(domain);
  if (!host) return { ok: false, reason: "invalid" };
  const refreshDays = opts.refreshDays ?? 7;
  const lockKey = `inst:lock:${host}`;

  try {
    if (kv && (await kv.get(lockKey))) return { ok: false, reason: "locked" };
    if (kv?.put) await kv.put(lockKey, "1", { expirationTtl: 300 });
  } catch {
    /* KV is best-effort: proceed without the lock */
  }

  try {
    if (!opts.force) {
      const existing = await getInstance(db, host);
      if (existing?.nextRefreshAt && existing.nextRefreshAt > new Date().toISOString()) {
        return { ok: false, reason: "not-due" };
      }
    }

    let metadata: InstanceMetadata | null = null;
    try {
      metadata = await fetchInstanceMetadata(host, opts.timeoutMs);
    } catch {
      metadata = null;
    }
    if (!metadata) {
      const existing = await getInstance(db, host);
      await recordInstanceRefreshFailure(db, host, nextRefreshFailureAt((existing?.refreshFailures ?? 0) + 1));
      return { ok: false, reason: "unreachable" };
    }

    const patch: InstanceMetadataPatch = { ...metadata, nextRefreshAt: nextRefreshSuccessAt(refreshDays) };
    await upsertInstanceMetadata(db, host, patch);
    return { ok: true, metadata };
  } finally {
    if (kv?.delete) await kv.delete(lockKey).catch(() => {});
  }
}

/**
 * Delivery failure → Mastodon failure tracker. Marks the host unavailable after
 * `INSTANCE_FAILURE_DAYS` distinct UTC failure days and sets a KV marker so the
 * queue consumer can skip it without hitting D1 per message.
 */
export async function recordInstanceDeliveryFailure(
  db: D1Database,
  kv: InstanceKV | null | undefined,
  domain: string,
  status: number,
  failureDaysThreshold: number = INSTANCE_FAILURE_DAYS
): Promise<void> {
  const host = normalizeDomain(domain);
  if (!host) return;
  const updated = await recordInstanceFailure(db, host, status, failureDaysThreshold).catch(() => null);
  await touchInstanceSeen(db, host, staggerRefreshAt()).catch(() => {});
  if (updated?.unavailable) {
    try {
      if (kv?.put) await kv.put(instanceDownKey(host), "1", { expirationTtl: DOWN_MARKER_TTL_SECONDS });
    } catch { /* marker is best-effort */ }
  }
}

/** Outbound delivery success → clear failures/availability and mark seen. */
export async function recordInstanceDeliverySuccess(
  db: D1Database,
  kv: InstanceKV | null | undefined,
  domain: string
): Promise<void> {
  const host = normalizeDomain(domain);
  if (!host) return;
  await recordInstanceSuccess(db, host).catch(() => {});
  try {
    if (kv?.delete) await kv.delete(instanceDownKey(host));
  } catch { /* marker is best-effort */ }
}

/**
 * A signed inbound activity proves the host is reachable: clear an unavailable
 * state (Mastodon's inbox-side `track_success!`) and refresh last_seen at most
 * once per hour to keep D1 writes bounded.
 */
export async function recordInstanceInboundActivity(
  db: D1Database,
  kv: InstanceKV | null | undefined,
  domain: string
): Promise<void> {
  const host = normalizeDomain(domain);
  if (!host) return;

  if (kv) {
    try {
      if (await kv.get(instanceDownKey(host))) {
        await recordInstanceSuccess(db, host);
        if (kv.delete) await kv.delete(instanceDownKey(host));
        return;
      }
      const seenKey = `inst:seen:${host}`;
      if (await kv.get(seenKey)) return;
      if (kv.put) await kv.put(seenKey, "1", { expirationTtl: 3_600 });
    } catch { /* fall through to the D1 write */ }
  }
  await touchInstanceSeen(db, host, staggerRefreshAt()).catch(() => {});
}

function deleteInstanceStatement(db: D1Database, domain: string) {
  return db.prepare("DELETE FROM instances WHERE domain = ?").bind(domain);
}

/**
 * Admin purge: delete every cached actor of the domain (objects cascade) plus
 * the instance/availability records. Cached posts from the domain disappear.
 */
export async function purgeInstanceDomain(db: D1Database, domain: string): Promise<number> {
  const host = normalizeDomain(domain);
  if (!host) return 0;
  const actorIds = await getActorIdsByDomain(db, host).catch(() => []);
  for (const id of actorIds) {
    await deleteRemoteActorData(db, id).catch(() => {});
  }
  await db.batch([
    deleteInstanceStatement(db, host),
    db.prepare("DELETE FROM delivery_rejections WHERE domain = ?").bind(host),
    db.prepare("DELETE FROM domain_capabilities WHERE domain = ?").bind(host),
  ]).catch(() => {});
  return actorIds.length;
}

/**
 * Backfill `actors.shared_inbox` for the actors that matter for delivery:
 * our followers first (they receive every post), then accounts local users
 * follow (mentions/replies). Bounded per cron tick; failures are parked in KV
 * for a week so one dead actor can't monopolize the batch. Without an
 * advertised shared inbox `collectFollowerInboxes` falls back to the per-user
 * inbox, which is noisier and times out on some implementations.
 */
export async function backfillRemoteSharedInboxes(
  db: D1Database,
  kv: InstanceKV | null | undefined,
  limit = 5
): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT a.id FROM actors a
       WHERE a.is_local = 0 AND a.shared_inbox IS NULL AND a.inbox IS NOT NULL AND a.inbox != ''
         AND (
           EXISTS (SELECT 1 FROM follows f WHERE f.actor_id = a.id AND f.state = 'accepted')
           OR EXISTS (SELECT 1 FROM follows f WHERE f.target_id = a.id AND f.state = 'accepted')
         )
       ORDER BY
         EXISTS (SELECT 1 FROM follows f WHERE f.actor_id = a.id AND f.state = 'accepted') DESC,
         a.updated_at DESC
       LIMIT ?`
    )
    .bind(Math.max(limit * 4, limit))
    .all<{ id: string }>();
  if (!rows.results?.length) return 0;

  const signer = await db
    .prepare("SELECT id, private_key_pem FROM actors WHERE is_local = 1 AND private_key_pem IS NOT NULL AND suspended = 0 LIMIT 1")
    .bind()
    .first<{ id: string; private_key_pem: string }>();
  if (!signer?.private_key_pem) return 0;

  let done = 0;
  for (const row of rows.results) {
    if (done >= limit) break;
    const skipKey = `actor:shared:skip:${row.id}`;
    try {
      if (kv && (await kv.get(skipKey))) continue;
    } catch { /* proceed without the marker */ }
    try {
      const doc = (await fetchRemoteObject(row.id, `${signer.id}#main-key`, signer.private_key_pem)) as APActor | null;
      if (doc?.inbox) {
        await upsertRemoteActor(db, doc);
        done++;
      } else if (kv?.put) {
        await kv.put(skipKey, "1", { expirationTtl: 604_800 });
      }
    } catch {
      try {
        if (kv?.put) await kv.put(skipKey, "1", { expirationTtl: 604_800 });
      } catch { /* best effort */ }
    }
  }
  return done;
}
