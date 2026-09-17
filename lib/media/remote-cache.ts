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
import { safeFetch, validateOutboundUrl } from "@/lib/activitypub/federation";
import {
  applyMediaCacheToActor,
  applyMediaCacheToAttachment,
  enqueueMediaCache,
  deleteMediaCacheRows,
  getMediaCacheStats,
  listExpiredMediaCache,
  listMediaCacheKeys,
  listMediaCacheQueue,
  listOldestMediaCache,
  markMediaCacheFailed,
  markMediaCacheReady,
  type MediaCacheStats,
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

export interface MediaCacheLimits {
  enabled: boolean;
  days: number;
  profileDays: number;
  maxBytes: number;
  maxObjectBytes: number;
  fetchBatch: number;
  /** Maintenance never shrinks the cache below this many entries. */
  minEntries: number;
  userAgents: string[];
}

/**
 * The limits object may be partial (an older `resolveLimits` build, a rolled
 * back constants module): undefined fields must mean "enabled with defaults",
 * never "disabled" — an undefined `enabled` previously fell into the disabled
 * branch and deleted the whole pending queue every tick.
 */
function normalizeLimits(limits: MediaCacheLimits): MediaCacheLimits {
  const days = Number(limits.days);
  const profileDays = Number(limits.profileDays);
  const maxBytes = Number(limits.maxBytes);
  const maxObjectBytes = Number(limits.maxObjectBytes);
  const fetchBatch = Number(limits.fetchBatch);
  const minEntries = Number(limits.minEntries);
  return {
    enabled: limits.enabled !== false,
    days: days > 0 ? days : 7,
    profileDays: profileDays > 0 ? profileDays : 30,
    maxBytes: maxBytes > 0 ? maxBytes : 10 * 1024 * 1024 * 1024,
    maxObjectBytes: maxObjectBytes > 0 ? maxObjectBytes : 40 * 1024 * 1024,
    fetchBatch: fetchBatch > 0 ? fetchBatch : 10,
    // 0 is a valid floor (used by tests); anything invalid falls back to 20.
    minEntries: Number.isFinite(minEntries) && minEntries >= 0 ? Math.floor(minEntries) : 20,
    userAgents: Array.isArray(limits.userAgents) && limits.userAgents.length > 0
      ? limits.userAgents
      : ["cf-activitypub/0.1.0 (+https://localhost; federated media cache)"],
  };
}

const FETCH_TIMEOUT_MS = 15_000;
// Old content queued by the backfill waits behind fresh ingests.
const BACKFILL_DELAY_SECONDS = 1_800;
const MAX_ATTEMPTS = 3;
const BYTES_KEY = "mediacache:bytes";
const RECOUNT_KEY = "mediacache:recount";
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

/** Read at most `max` bytes of a response body (bounded memory). */
async function readBoundedBytes(res: Response, max: number): Promise<Uint8Array | null> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buffer = await res.arrayBuffer().catch(() => null);
    if (!buffer || buffer.byteLength > max) return null;
    return new Uint8Array(buffer);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) return null;
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function adjustBytes(kv: MediaCacheKV, delta: number): Promise<void> {
  try {
    const current = Number((await kv.get(BYTES_KEY)) ?? 0) || 0;
    await kv.put(BYTES_KEY, String(Math.max(0, current + delta)));
  } catch { /* counter is best-effort; the daily recount fixes drift */ }
}

async function currentBytes(kv: MediaCacheKV, stats: MediaCacheStats): Promise<number> {
  try {
    const cached = await kv.get(BYTES_KEY);
    if (cached !== null && cached !== "") return Number(cached) || 0;
  } catch { /* fall through */ }
  return stats.bytes;
}

/** Download one queued resource and point its target at the cached copy. */
async function cacheOne(
  bindings: MediaCacheBindings,
  limits: MediaCacheLimits,
  job: MediaCacheEntry,
  baseUrl: string
): Promise<boolean> {
  const validation = validateOutboundUrl(job.sourceUrl);
  if (!validation.valid) {
    await markMediaCacheFailed(bindings.DB, job.id, validation.reason ?? "blocked", plusHours(24 * 7), "failed");
    return false;
  }

  let lastError = "unreachable";
  let permanent = false;

  for (const userAgent of limits.userAgents) {
    let res: Response | null = null;
    try {
      res = await safeFetch(
        job.sourceUrl,
        {
          headers: {
            "User-Agent": userAgent,
            Accept: "image/avif,image/webp,image/*,video/*,audio/*,*/*;q=0.8",
          },
        },
        FETCH_TIMEOUT_MS
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
      permanent = true;
      lastError = `HTTP ${res.status}`;
      break;
    }
    if (!res.ok) {
      lastError = `HTTP ${res.status}`;
      await res.body?.cancel().catch(() => {});
      // 401/403/406/429/451 → the next user agent may be accepted.
      continue;
    }

    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!isCacheableType(contentType)) {
      permanent = true;
      lastError = `Unsupported content type ${contentType || "unknown"}`;
      await res.body?.cancel().catch(() => {});
      break;
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > limits.maxObjectBytes) {
      permanent = true;
      lastError = `Too large (${declared} bytes)`;
      await res.body?.cancel().catch(() => {});
      break;
    }
    const bytes = await readBoundedBytes(res, limits.maxObjectBytes);
    if (!bytes) {
      permanent = true;
      lastError = "Body exceeds the size limit";
      break;
    }

    const r2Key = `cache/media/${job.id}.${extensionFor(contentType, job.sourceUrl)}`;
    try {
      await bindings.R2.put(r2Key, bytes, {
        httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" },
        customMetadata: { sourceUrl: job.sourceUrl.slice(0, 900) },
      });
      const cachedUrl = `${baseUrl}/api/media/${r2Key}`;
      await markMediaCacheReady(bindings.DB, job.id, { r2Key, size: bytes.byteLength, contentType });
      if (job.targetType === "attachment" && job.targetId) {
        await applyMediaCacheToAttachment(bindings.DB, job.targetId, job.sourceUrl, cachedUrl, bytes.byteLength, contentType);
      } else if ((job.targetType === "avatar" || job.targetType === "header") && job.targetId) {
        await applyMediaCacheToActor(bindings.DB, job.targetId, job.targetType, job.sourceUrl, cachedUrl);
      }
      await adjustBytes(bindings.KV, bytes.byteLength);
      return true;
    } catch (err) {
      // Storage/bookkeeping failure: count the attempt so the row backs off
      // instead of being retried on every single tick.
      lastError = `store failed: ${String(err)}`;
      break;
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
  const jobs = await listMediaCacheQueue(bindings.DB, limit ?? limits.fetchBatch);
  // Fetch concurrently so the cron stage costs ~one media download instead of
  // batch × timeout.
  const results = await Promise.allSettled(jobs.map((job) => cacheOne(bindings, limits, job, baseUrl)));
  return results.filter((r) => r.status === "fulfilled" && r.value).length;
}

async function deleteEntries(
  bindings: MediaCacheBindings,
  entries: { id: string; r2_key: string | null; size: number }[]
): Promise<number> {
  if (entries.length === 0) return 0;
  let freed = 0;
  for (const entry of entries) {
    if (entry.r2_key) {
      await bindings.R2.delete(entry.r2_key).catch(() => {});
    }
    freed += Number(entry.size ?? 0);
  }
  await deleteMediaCacheRows(bindings.DB, entries.map((e) => e.id));
  await adjustBytes(bindings.KV, -freed);
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
  let queued = 0;

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
           AND a.last_status_at IS NOT NULL AND a.last_status_at >= datetime('now', '-14 days')
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
): Promise<{ expired: number; evicted: number }> {
  const limits = normalizeLimits(rawLimits);
  if (!limits.enabled) {
    return { expired: 0, evicted: 0 };
  }

  let stats = await getMediaCacheStats(bindings.DB);
  let remaining = stats.ready;
  const floor = Math.max(0, Math.min(limits.minEntries, remaining));
  // Hard cap of deletions per tick: lowering MEDIA_CACHE_MAX_BYTES (or a long
  // dormancy) shrinks the cache progressively instead of mass-deleting, and
  // the floor guarantees it is never wiped.
  let deletionsLeft = Math.max(1, batch);

  // 1) Age-based expiry, oldest first, never below the floor.
  const expiredRows = await listExpiredMediaCache(bindings.DB, limits.days, limits.profileDays, batch);
  const expirable = expiredRows.slice(0, Math.min(Math.max(0, remaining - floor), deletionsLeft));
  await deleteEntries(bindings, expirable);
  remaining -= expirable.length;
  deletionsLeft -= expirable.length;

  // 2) Byte-budget eviction: FIFO (oldest `fetched_at` first). Everything just
  // fetched stays; the budget is adapted to gradually when it is reduced.
  let bytes = await currentBytes(bindings.KV, stats);
  let evicted = 0;
  const budget = Math.max(1, limits.maxBytes);
  while (bytes > budget && remaining > floor && deletionsLeft > 0) {
    const room = Math.max(1, Math.min(deletionsLeft, remaining - floor));
    const oldest = await listOldestMediaCache(bindings.DB, room);
    if (oldest.length === 0) break;
    const doomed: typeof oldest = [];
    for (const entry of oldest) {
      if (bytes <= budget || remaining <= floor || deletionsLeft <= 0) break;
      doomed.push(entry);
      bytes -= Number(entry.size ?? 0);
      remaining -= 1;
      deletionsLeft -= 1;
    }
    if (doomed.length === 0) break;
    const freed = await deleteEntries(bindings, doomed);
    evicted += doomed.length;
    if (freed === 0) break;
  }

  // Recompute the byte counter once a day so the KV drift stays bounded.
  try {
    if (!(await bindings.KV.get(RECOUNT_KEY))) {
      await bindings.KV.put(RECOUNT_KEY, "1", { expirationTtl: 86_400 });
      stats = await getMediaCacheStats(bindings.DB);
      await bindings.KV.put(BYTES_KEY, String(stats.bytes));
    }
  } catch { /* best-effort */ }

  return { expired: expirable.length, evicted };
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
  try { await bindings.KV.put(BYTES_KEY, "0"); } catch { /* best-effort */ }
  return removed;
}
