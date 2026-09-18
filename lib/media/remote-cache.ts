/**
 * Remote media cache (R2) — Mastodon-style caching of federated resources.
 *
 * Status attachments and profile avatars/headers from other servers are
 * downloaded once, stored in R2 and served from our own domain, so clients no
 * longer hit the origin server (which may be slow, rate-limited or gone).
 *
 * Behaviour mirrors Mastodon:
 *  - the request goes out with the instance bot user agent first, then common
 *    browser user agents (some origins block bots outright);
 *  - `attachments.remote_url` / `actors.avatar_url` keep the origin while the
 *    served `url` / `*_cache_url` point at the cached copy;
 *  - entries expire (7 days for attachments, 30 for profiles by default) and
 *    the cache is trimmed to a byte budget, oldest first.
 *
 * Everything is controlled by env vars (see `resolveLimits` and wrangler.toml):
 * MEDIA_CACHE_ENABLED, _DAYS, _PROFILE_DAYS, _MAX_BYTES, _MAX_OBJECT_BYTES,
 * _FETCH_BATCH, _USER_AGENTS.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { resolveLimits, type InstanceLimits } from "@/lib/constants";
import { validateOutboundUrl } from "@/lib/activitypub/federation";
import { fetchWithUserAgents, readBoundedBytes } from "@/lib/media/fetch";
import {
  applyMediaCacheToActorsByUrl,
  applyMediaCacheToAttachmentsByUrl,
  applyMediaCacheToPreviewCardsByUrl,
  enqueueMediaCache,
  deleteMediaCacheRows,
  getMediaCacheStats,
  listExpiredMediaCache,
  listMediaCacheKeys,
  listMediaCacheQueue,
  listOldestMediaCache,
  listOrphanMediaCache,
  listPreviewCardsMissingImageCache,
  markMediaCacheFailed,
  markMediaCacheReady,
  resetMediaCacheReferences,
} from "@/lib/db";
import type { MediaCacheEntry } from "@/lib/types";

export interface MediaCacheKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Minimal R2 surface used here — the generated `CloudflareEnv.R2` type and
 * `@cloudflare/workers-types` disagree across the two definitions the app has.
 */
export interface MediaCacheR2 {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
    options?: { httpMetadata?: { contentType?: string; cacheControl?: string }; customMetadata?: Record<string, string> }
  ): Promise<unknown>;
  delete(key: string | string[]): Promise<void>;
}

export interface MediaCacheBindings {
  DB: D1Database;
  R2: MediaCacheR2;
  KV: MediaCacheKV;
}

/**
 * Limits for the cache. Every field is optional so the object can be built in
 * one place (tests, admin endpoint) — and the `mediaCache*` variants are
 * accepted too: the cron used to hand this module the raw `resolveLimits()`
 * object (whose fields are prefixed) and the mismatch silently fell back to the
 * 10 GiB default, so `MEDIA_CACHE_MAX_BYTES` was never applied.
 */
export interface NormalizedMediaCacheLimits {
  enabled: boolean;
  days: number;
  profileDays: number;
  maxBytes: number;
  maxObjectBytes: number;
  fetchBatch: number;
  minEntries: number;
  userAgents: string[];
}

export interface MediaCacheLimits {
  enabled?: boolean;
  days?: number;
  profileDays?: number;
  maxBytes?: number;
  maxObjectBytes?: number;
  fetchBatch?: number;
  /** Maintenance never shrinks the cache below this many entries. */
  minEntries?: number;
  userAgents?: string[];
  mediaCacheEnabled?: boolean;
  mediaCacheDays?: number;
  mediaCacheProfileDays?: number;
  mediaCacheMaxBytes?: number;
  mediaCacheMaxObjectBytes?: number;
  mediaCacheFetchBatch?: number;
  mediaCacheMinEntries?: number;
  mediaCacheUserAgents?: string[];
}

/**
 * The limits object may be partial (an older `resolveLimits` build, a rolled
 * back constants module): undefined fields must mean "enabled with defaults",
 * never "disabled" — an undefined `enabled` previously fell into the disabled
 * branch and deleted the whole pending queue every tick.
 */
/**
 * Build the cache limits from the instance limits object. The cron used to pass
 * `resolveLimits()` straight in and every field was read with the wrong name,
 * so the defaults (10 GiB!) silently won. Keep the mapping in a typechecked
 * file so a rename is a compile error, not a runtime fallback.
 */
export function mediaCacheLimitsFrom(limits: InstanceLimits): MediaCacheLimits {
  return {
    enabled: limits.mediaCacheEnabled,
    days: limits.mediaCacheDays,
    profileDays: limits.mediaCacheProfileDays,
    maxBytes: limits.mediaCacheMaxBytes,
    maxObjectBytes: limits.mediaCacheMaxObjectBytes,
    fetchBatch: limits.mediaCacheFetchBatch,
    minEntries: limits.mediaCacheMinEntries,
    userAgents: limits.mediaCacheUserAgents,
  };
}

/** Convenience for callers that only hold the raw env. */
export function resolveMediaCacheLimits(env: Record<string, unknown>): MediaCacheLimits {
  return mediaCacheLimitsFrom(resolveLimits(env));
}

function normalizeLimits(limits: MediaCacheLimits): NormalizedMediaCacheLimits {
  const pick = <T>(plain: T | undefined, prefixed: T | undefined): T | undefined =>
    plain !== undefined ? plain : prefixed;
  const days = Number(pick(limits.days, limits.mediaCacheDays));
  const profileDays = Number(pick(limits.profileDays, limits.mediaCacheProfileDays));
  const maxBytes = Number(pick(limits.maxBytes, limits.mediaCacheMaxBytes));
  const maxObjectBytes = Number(pick(limits.maxObjectBytes, limits.mediaCacheMaxObjectBytes));
  const fetchBatch = Number(pick(limits.fetchBatch, limits.mediaCacheFetchBatch));
  const minEntries = Number(pick(limits.minEntries, limits.mediaCacheMinEntries));
  const userAgents = pick(limits.userAgents, limits.mediaCacheUserAgents);
  const enabled = pick(limits.enabled, limits.mediaCacheEnabled);
  return {
    enabled: enabled !== false,
    days: days > 0 ? days : 7,
    profileDays: profileDays > 0 ? profileDays : 30,
    maxBytes: maxBytes > 0 ? maxBytes : 10 * 1024 * 1024 * 1024,
    maxObjectBytes: maxObjectBytes > 0 ? maxObjectBytes : 40 * 1024 * 1024,
    fetchBatch: fetchBatch > 0 ? fetchBatch : 10,
    // 0 is a valid floor (used by tests); anything invalid falls back to 20.
    minEntries: Number.isFinite(minEntries) && minEntries >= 0 ? Math.floor(minEntries) : 20,
    userAgents: Array.isArray(userAgents) && userAgents.length > 0
      ? userAgents
      : ["cf-activitypub/0.1.0 (+https://localhost; federated media cache)"],
  };
}

const FETCH_TIMEOUT_MS = 15_000;
// Eviction is bounded by BYTES per tick, not by entry count: draining a large
// overage with an entry cap matched the fetch rate and never got under the
// budget. 500 MB/tick drains ~16 GB in ~35 minutes while fetching pauses.
const EVICT_BYTES_PER_TICK = 500 * 1024 * 1024;
const EVICT_BATCH = 100;
// Never let the cron stage run long enough to hold the run lock: eviction
// stops at the deadline and resumes on the next tick.
const MAINTENANCE_DEADLINE_MS = 25_000;
const R2_DELETE_CONCURRENCY = 40;
// Old content queued by the backfill waits briefly behind fresh ingests (a
// long delay left the backlog unattended — the queue must keep draining).
const BACKFILL_DELAY_SECONDS = 300;
const MAX_ATTEMPTS = 3;
const RETRY_HOURS = 6;

/** Media types worth caching (SVG is excluded: it can execute when opened). */
function isCacheableType(contentType: string): boolean {
  if (!contentType) return false;
  if (contentType === "image/svg+xml") return false;
  return contentType.startsWith("image/") || contentType.startsWith("video/") || contentType.startsWith("audio/");
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/ogg": "ogv",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
};

function extensionFor(contentType: string, url: string): string {
  const byType = EXTENSIONS[contentType];
  if (byType) return byType;
  const path = url.split("?")[0];
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return /^[a-z0-9]{2,5}$/.test(ext) ? ext : "bin";
}

function plusHours(hours: number, from = Date.now()): string {
  return new Date(from + hours * 3_600_000).toISOString();
}

/** Download one queued resource and point its target at the cached copy. */
async function cacheOne(
  bindings: MediaCacheBindings,
  limits: NormalizedMediaCacheLimits,
  job: MediaCacheEntry,
  baseUrl: string
): Promise<boolean> {
  const validation = validateOutboundUrl(job.sourceUrl);
  if (!validation.valid) {
    await markMediaCacheFailed(bindings.DB, job.id, validation.reason ?? "blocked", plusHours(24 * 7), "failed");
    return false;
  }

  const fetched = await fetchWithUserAgents(job.sourceUrl, {
    userAgents: limits.userAgents,
    accept: "image/avif,image/webp,image/*,video/*,audio/*,*/*;q=0.8",
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: limits.maxObjectBytes,
    isAcceptableType: isCacheableType,
  });

  let lastError = fetched.ok ? "unreachable" : fetched.error;
  let permanent = !fetched.ok && fetched.permanent;

  if (fetched.ok) {
    const bytes = await readBoundedBytes(fetched.response, limits.maxObjectBytes);
    if (!bytes) {
      permanent = true;
      lastError = "Body exceeds the size limit";
    } else {
      const contentType = fetched.contentType;
      const r2Key = `cache/media/${job.id}.${extensionFor(contentType, job.sourceUrl)}`;
      try {
        await bindings.R2.put(r2Key, bytes, {
          httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" },
          customMetadata: { sourceUrl: job.sourceUrl.slice(0, 900) },
        });
        const cachedUrl = `${baseUrl}/api/media/${r2Key}`;
        await markMediaCacheReady(bindings.DB, job.id, { r2Key, cachedUrl, size: bytes.byteLength, contentType });
        // Rewrite every reference to this URL, not just the trigger target.
        await applyMediaCacheToAttachmentsByUrl(bindings.DB, job.sourceUrl, cachedUrl, bytes.byteLength, contentType);
        if (job.targetType === "avatar" || job.targetType === "header") {
          await applyMediaCacheToActorsByUrl(bindings.DB, job.targetType, job.sourceUrl, cachedUrl);
        }
        if (job.targetType === "card") {
          await applyMediaCacheToPreviewCardsByUrl(bindings.DB, job.sourceUrl, cachedUrl);
        }
        return true;
      } catch (err) {
        // Storage/bookkeeping failure: count the attempt so the row backs off
        // instead of being retried on every single tick.
        lastError = `store failed: ${String(err)}`;
      }
    }
  }

  const attempts = job.attempts + 1;
  const giveUp = permanent || attempts >= MAX_ATTEMPTS;
  await markMediaCacheFailed(
    bindings.DB,
    job.id,
    lastError,
    giveUp ? plusHours(24 * 7) : plusHours(Math.min(attempts * RETRY_HOURS, 24)),
    giveUp ? "failed" : "pending"
  );
  return false;
}

/**
 * Cache up to `limit` queued resources (cron stage). When the feature is
 * disabled, queued rows are dropped so metadata doesn't accumulate.
 */
export async function processMediaCacheQueue(
  bindings: MediaCacheBindings,
  rawLimits: MediaCacheLimits,
  baseUrl: string,
  limit?: number
): Promise<number> {
  const limits = normalizeLimits(rawLimits);
  if (!limits.enabled) {
    // Leave queued rows alone: they are tiny metadata and will be processed if
    // the cache is re-enabled. (Deleting here used to wipe the queue silently.)
    return 0;
  }
  // Rolling window: maintenance (FIFO eviction) runs before this stage every
  // tick, so fresh media always enters and the oldest leaves. Pausing at
  // `>= maxBytes` used to stall the queue forever at the (normal) steady state
  // where the cache sits at its cap — new statuses never got their media.
  // Only a runaway overage (eviction behind) pauses fetching.
  const stats = await getMediaCacheStats(bindings.DB);
  if (stats.bytes > limits.maxBytes * 2) return 0;
  const jobs = await listMediaCacheQueue(bindings.DB, limit ?? limits.fetchBatch);
  // Fetch concurrently so the cron stage costs ~one media download instead of
  // batch × timeout.
  const results = await Promise.allSettled(jobs.map((job) => cacheOne(bindings, limits, job, baseUrl)));
  return results.filter((r) => r.status === "fulfilled" && r.value).length;
}

async function deleteEntries(
  bindings: MediaCacheBindings,
  entries: { id: string; r2_key: string | null; size: number; source_url?: string | null }[]
): Promise<number> {
  if (entries.length === 0) return 0;
  let freed = 0;
  for (const entry of entries) freed += Number(entry.size ?? 0);
  // R2 deletes are network calls: run them in parallel chunks. Doing ~700 of
  // them sequentially pushed the cron stage past the run-lock window.
  for (let i = 0; i < entries.length; i += R2_DELETE_CONCURRENCY) {
    await Promise.allSettled(
      entries.slice(i, i + R2_DELETE_CONCURRENCY).map((entry) =>
        entry.r2_key ? bindings.R2.delete(entry.r2_key) : Promise.resolve()
      )
    );
  }
  // Point every reference back at the origin BEFORE the row disappears: an
  // evicted/expired copy left `actors.avatar_cache_url`, `attachments.url`
  // and card snapshots pointing at a dead `/api/media/...` URL.
  await resetMediaCacheReferences(
    bindings.DB,
    entries.map((entry) => entry.source_url ?? null)
  );
  await deleteMediaCacheRows(bindings.DB, entries.map((e) => e.id));
  return freed;
}

/**
 * Queue federated resources that were ingested before the cache existed (or
 * were never queued): recent remote attachments plus avatars/headers of
 * accounts followed locally, then recently active remote accounts. Bounded per
 * tick so the D1 write budget stays small.
 */
export async function backfillMediaCache(
  bindings: MediaCacheBindings,
  rawLimits: MediaCacheLimits,
  batch = 20
): Promise<number> {
  const limits = normalizeLimits(rawLimits);
  if (!limits.enabled) return 0;
  // Backfill is optional work: while over budget, only fresh media (and
  // maintenance) get the tick.
  const cacheStats = await getMediaCacheStats(bindings.DB);
  if (cacheStats.bytes > limits.maxBytes) return 0;
  let queued = 0;

  // Heal references that were left on the origin before the URL-based
  // rewrite existed (or when the same file backs several posts).
  try {
    const stale = await bindings.DB
      .prepare(
        `SELECT DISTINCT a.remote_url AS source_url, mc.cached_url, mc.size, mc.content_type
         FROM attachments a
         JOIN media_cache mc ON mc.source_url = a.remote_url AND mc.status = 'ready'
         WHERE mc.cached_url IS NOT NULL
           AND a.url NOT LIKE '%/api/media/cache/media/%' AND a.url = a.remote_url
         LIMIT ?`
      )
      .bind(batch)
      .all<{ source_url: string; cached_url: string; size: number; content_type: string | null }>();
    for (const row of stale.results ?? []) {
      await applyMediaCacheToAttachmentsByUrl(bindings.DB, row.source_url, row.cached_url, Number(row.size ?? 0), row.content_type ?? null);
      queued++;
    }
  } catch { /* best-effort */ }

  try {
    const attachments = await bindings.DB
      .prepare(
        `SELECT a.id, a.url FROM attachments a
         JOIN objects o ON o.id = a.object_id
         WHERE o.is_local = 0 AND a.url LIKE 'https://%' AND a.url NOT LIKE '%/api/media/cache/media/%'
           AND NOT EXISTS (SELECT 1 FROM media_cache mc WHERE mc.source_url = a.url)
         ORDER BY o.published DESC LIMIT ?`
      )
      .bind(batch)
      .all<{ id: string; url: string }>();
    for (const row of attachments.results ?? []) {
      await enqueueMediaCache(bindings.DB, row.url, "attachment", row.id, BACKFILL_DELAY_SECONDS);
      queued++;
    }
  } catch { /* the table may be missing pre-migration */ }

  // Preview card images of recently crawled links (served from R2 once done).
  try {
    const cards = await listPreviewCardsMissingImageCache(bindings.DB, batch);
    for (const card of cards) {
      await enqueueMediaCache(bindings.DB, card.imageUrl, "card", card.id, BACKFILL_DELAY_SECONDS);
      queued++;
    }
  } catch { /* the table may be missing pre-migration */ }

  // Profiles of accounts with a local follow relation first (small set),
  // then recently active remote accounts.
  try {
    const followed = await bindings.DB
      .prepare(
        `SELECT a.id, a.avatar_url, a.header_url FROM actors a
         WHERE a.is_local = 0 AND a.avatar_url LIKE 'https://%'
           AND (a.avatar_cache_url IS NULL OR a.header_cache_url IS NULL)
           AND EXISTS (
             SELECT 1 FROM follows f
             WHERE f.state = 'accepted' AND (f.actor_id = a.id OR f.target_id = a.id)
           )
         LIMIT ?`
      )
      .bind(batch)
      .all<{ id: string; avatar_url: string | null; header_url: string | null }>();
    for (const row of followed.results ?? []) {
      if (row.avatar_url) {
        await enqueueMediaCache(bindings.DB, row.avatar_url, "avatar", row.id, BACKFILL_DELAY_SECONDS);
        queued++;
      }
      if (row.header_url) {
        await enqueueMediaCache(bindings.DB, row.header_url, "header", row.id, BACKFILL_DELAY_SECONDS);
        queued++;
      }
    }

    const recent = await bindings.DB
      .prepare(
        `SELECT a.id, a.avatar_url FROM actors a
         WHERE a.is_local = 0 AND a.avatar_url LIKE 'https://%' AND a.avatar_cache_url IS NULL
           AND a.last_status_at IS NOT NULL AND a.last_status_at >= date('now', '-14 days')
         ORDER BY a.last_status_at DESC LIMIT ?`
      )
      .bind(batch)
      .all<{ id: string; avatar_url: string }>();
    for (const row of recent.results ?? []) {
      await enqueueMediaCache(bindings.DB, row.avatar_url, "avatar", row.id, BACKFILL_DELAY_SECONDS);
      queued++;
    }
  } catch { /* best-effort */ }

  return queued;
}

/**
 * Expiry + space maintenance, called every cron tick with small batches:
 *  1. delete entries past their retention window (attachments `days`,
 *     profiles `profile_days`, keeping profiles of locally followed accounts);
 *  2. evict oldest entries until the byte budget is respected.
 */
export async function maintainMediaCache(
  bindings: MediaCacheBindings,
  rawLimits: MediaCacheLimits,
  batch = 50
): Promise<{ expired: number; evicted: number; orphaned: number; bytesBefore: number; bytesAfter: number; overBudget: boolean }> {
  const limits = normalizeLimits(rawLimits);
  if (!limits.enabled) {
    return { expired: 0, evicted: 0, orphaned: 0, bytesBefore: 0, bytesAfter: 0, overBudget: false };
  }

  const stats = await getMediaCacheStats(bindings.DB);
  let remaining = stats.ready;
  const floor = Math.max(0, Math.min(limits.minEntries, remaining));

  // 1) Age-based expiry, oldest first, never below the floor.
  const expiredRows = await listExpiredMediaCache(bindings.DB, limits.days, limits.profileDays, batch);
  const expirable = expiredRows.slice(0, Math.max(0, remaining - floor));
  await deleteEntries(bindings, expirable);
  remaining -= expirable.length;

  // 2) Byte-budget eviction: FIFO (oldest `fetched_at` first), up to
  // EVICT_BYTES_PER_TICK so a large overage (or a lowered
  // MEDIA_CACHE_MAX_BYTES) is actually drained instead of being outpaced by
  // new fetches. The floor still guarantees the cache is never wiped.
  const expiredBytes = expirable.reduce((sum, e) => sum + Number(e.size ?? 0), 0);
  const bytesBefore = stats.bytes;
  let bytes = Math.max(0, stats.bytes - expiredBytes);
  let evicted = 0;
  let evictedBytes = 0;
  const budget = Math.max(1, limits.maxBytes);
  const deadline = Date.now() + MAINTENANCE_DEADLINE_MS;
  while (bytes > budget && remaining > floor && evictedBytes < EVICT_BYTES_PER_TICK && Date.now() < deadline) {
    const oldest = await listOldestMediaCache(bindings.DB, Math.max(1, Math.min(EVICT_BATCH, remaining - floor)));
    if (oldest.length === 0) break;
    const doomed: typeof oldest = [];
    for (const entry of oldest) {
      if (bytes <= budget || remaining <= floor || evictedBytes >= EVICT_BYTES_PER_TICK || Date.now() >= deadline) break;
      doomed.push(entry);
      const size = Number(entry.size ?? 0);
      bytes -= size;
      evictedBytes += size;
      remaining -= 1;
    }
    if (doomed.length === 0) break;
    const freed = await deleteEntries(bindings, doomed);
    evicted += doomed.length;
    if (freed === 0) break;
  }

  // 3) Drop entries whose owner is gone: the status/attachment was deleted
  // (cascade), the avatar was replaced, or the account is gone. The avatar of
  // a live account is never touched — it only dies with the actor row.
  let orphaned = 0;
  try {
    const orphans = await listOrphanMediaCache(bindings.DB, batch);
    await deleteEntries(bindings, orphans);
    orphaned = orphans.length;
  } catch { /* best-effort */ }

  if (bytes > budget && evicted === 0 && expirable.length === 0) {
    // No progress: the cache is over its limit and this run could not delete
    // anything (floor reached, list failures, R2/D1 deletes failing…). While
    // the FIFO drain is making progress this is a normal multi-tick state.
    console.error(
      `[media-cache] still over budget and not draining: ${Math.round(bytes / 1048576)} MB > ${Math.round(budget / 1048576)} MB`
    );
  }

  return { expired: expirable.length, evicted, orphaned, bytesBefore, bytesAfter: bytes, overBudget: bytes > budget };
}

/** Remove every cached object and row (admin purge). */
export async function purgeMediaCache(bindings: MediaCacheBindings): Promise<number> {
  let removed = 0;
  for (;;) {
    const entries = await listMediaCacheKeys(bindings.DB, 100);
    if (entries.length === 0) break;
    await deleteEntries(bindings, entries.map((e) => ({ ...e, size: 0 })));
    removed += entries.length;
  }
  return removed;
}

/**
 * Run maintenance repeatedly (bounded by `maxMs`) until the cache is under
 * `MEDIA_CACHE_MAX_BYTES`. Used by the admin endpoint to enforce a lowered
 * limit immediately and to surface per-iteration results when debugging.
 */
export async function enforceMediaCacheBudget(
  bindings: MediaCacheBindings,
  rawLimits: MediaCacheLimits,
  maxMs = 60_000
): Promise<{ iterations: number; expired: number; evicted: number; orphaned: number; bytesBefore: number; bytesAfter: number }> {
  const limits = normalizeLimits(rawLimits);
  const statsBefore = await getMediaCacheStats(bindings.DB);
  let expired = 0;
  let evicted = 0;
  let orphaned = 0;
  let iterations = 0;
  const deadline = Date.now() + maxMs;
  let bytes = statsBefore.bytes;

  while (bytes > limits.maxBytes && Date.now() < deadline) {
    const result = await maintainMediaCache(bindings, limits);
    iterations += 1;
    expired += result.expired;
    evicted += result.evicted;
    orphaned += result.orphaned;
    bytes = (await getMediaCacheStats(bindings.DB)).bytes;
    // No progress (nothing deletable / deletes failing): stop instead of looping.
    if (result.evicted === 0 && result.expired === 0) break;
  }

  return { iterations, expired, evicted, orphaned, bytesBefore: statsBefore.bytes, bytesAfter: bytes };
}
