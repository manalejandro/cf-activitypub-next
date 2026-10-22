/**
 * The instance's live status, computed once and shared by both surfaces: the
 * public status page (`/status` + `GET /api/v1/status`) and the admin
 * statistics panel (`/admin/stats` + `GET /api/v1/admin/stats`).
 *
 * Both read the same component states, so the page an operator shows visitors
 * and the one they debug with can never disagree. Every number comes from data
 * the instance already has — D1 counts, the media cache, the cron's liveness
 * marker, the delivery dead-letter log, the streaming Durable Object — and
 * nothing is invented: there is no synthetic uptime percentage, because a
 * figure nobody can verify is worse than no figure. A component whose data is
 * missing reports `unknown` instead of a made-up green.
 *
 * Thresholds are exported so the tests pin them and the UI can explain them.
 */

import type { D1Database, DurableObjectId } from "@cloudflare/workers-types";
import {
  getAnonymousTimelineAccess,
  getMediaCacheStats,
  getRegistrationSettings,
} from "@/lib/db";
import { resolveLimits } from "@/lib/constants";
import { readStorageRetentionStats, storageRetentionLimitsFrom } from "@/lib/storage-retention";

export type ComponentState = "operational" | "degraded" | "down" | "unknown" | "disabled";

export interface StatusComponent {
  /** Stable key the clients translate (`status_component_<key>`): never prose. */
  key: string;
  state: ComponentState;
  /** Measured values; the client composes every label from them. */
  metrics: Record<string, number | string | null>;
}

export interface InstanceStatusSnapshot {
  checked_at: string;
  version: string;
  overall: ComponentState;
  components: StatusComponent[];
  metrics: Record<string, number | string | null>;
}

/** A database probe slower than this is reported as degraded. */
export const DB_SLOW_MS = 500;
/** No inbound federated activity for this long (with a federation graph) is degraded. */
export const FEDERATION_STALE_HOURS = 48;
/** The cron fires every minute: a completed run newer than this is healthy. */
export const MAINTENANCE_OK_MINUTES = 10;
/** A completed run older than this means maintenance is not running. */
export const MAINTENANCE_STALE_MINUTES = 60;
/** Delivery failures recorded in 24h: at least this many is degraded. */
export const DELIVERY_DEGRADED_FAILURES = 3;
/** Delivery failures recorded in 24h: at least this many is down. */
export const DELIVERY_DOWN_FAILURES = 10;
/** A media-cache backlog over this many cron batches is degraded. */
export const MEDIA_BACKLOG_FACTOR = 10;

/** Key the cron writes at the end of every completed run (2-day TTL). */
export const CRON_LAST_KEY = "cron:last";
/** Key the cron holds while a run is in flight. */
export const CRON_LOCK_KEY = "cron:lock";
/** Prefix of the delivery dead-letter records (the key carries the timestamp). */
export const DLQ_PREFIX = "dlq:delivery:";

const SEVERITY: Record<ComponentState, number> = {
  down: 3,
  degraded: 2,
  operational: 1,
  unknown: 0,
  disabled: 0,
};

/** The worst component state, which is what the banner shows. */
export function summarizeOverall(components: StatusComponent[]): ComponentState {
  let worst: ComponentState = "operational";
  for (const component of components) {
    if (SEVERITY[component.state] > SEVERITY[worst]) worst = component.state;
  }
  return worst;
}

// The state decisions are pure functions so the thresholds are unit-tested
// without a database: every rule is one line and every one is pinned.

export function databaseState(probeMs: number | null): ComponentState {
  if (probeMs === null) return "down";
  return probeMs > DB_SLOW_MS ? "degraded" : "operational";
}

/**
 * Federation is judged by inbound activity (only recorded after the signature
 * checks) and only while someone here actually follows a remote account: a
 * brand-new server, or one that only ever browsed remote profiles, is not
 * "degraded" for the silence of a graph it does not have.
 */
export function federationState(activityMinutes: number | null, remoteFollows: number): ComponentState {
  if (remoteFollows === 0) return "operational";
  if (activityMinutes === null || activityMinutes > FEDERATION_STALE_HOURS * 60) return "degraded";
  return "operational";
}

export function deliveryState(failures24h: number): ComponentState {
  if (failures24h >= DELIVERY_DOWN_FAILURES) return "down";
  if (failures24h >= DELIVERY_DEGRADED_FAILURES) return "degraded";
  return "operational";
}

export function mediaState(input: {
  enabled: boolean;
  bytes: number;
  pending: number;
  maxBytes: number;
  fetchBatch: number;
}): ComponentState {
  if (!input.enabled) return "disabled";
  const backlogLimit = input.fetchBatch * MEDIA_BACKLOG_FACTOR;
  if (input.bytes > input.maxBytes || input.pending > backlogLimit) return "degraded";
  return "operational";
}

export function maintenanceState(lastRunMinutes: number | null): ComponentState {
  if (lastRunMinutes === null) return "unknown";
  if (lastRunMinutes > MAINTENANCE_STALE_MINUTES) return "down";
  if (lastRunMinutes > MAINTENANCE_OK_MINUTES) return "degraded";
  return "operational";
}

interface KvBinding {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  list?(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

interface DoNamespaceBinding {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(input: string): Promise<Response> };
}

export interface StatsEnv {
  DB: D1Database;
  KV: KvBinding;
  TIMELINE_STREAM?: DoNamespaceBinding;
  INSTANCE_VERSION?: string;
  AI?: unknown;
  VECTORIZE?: unknown;
  EMAIL?: unknown;
  TURNSTILE_SECRET?: string;
}

interface CronHealth {
  lastRunAt: string | null;
  lastDurationMs: number | null;
  stage: string | null;
}

interface ActorSummary {
  local: number;
  remote: number;
  suspended: number;
  limited: number;
  memorial: number;
  pending: number;
  firstLocalAt: string | null;
}

interface ObjectSummary {
  local: number;
  remote: number;
  local24h: number;
}

interface FederationSummary {
  domains: number;
  unavailable: number;
  lastActivityAt: string | null;
  /** Accepted follows whose target is remote: the graph that should bring activity in. */
  remoteFollows: number;
}

interface ModerationSummary {
  openReports: number;
  decisions24h: number;
}

interface MediaSummary {
  ready: number;
  pending: number;
  failed: number;
  bytes: number;
  oldestFetchedAt: string | null;
}

interface StreamingHealth {
  state: ComponentState;
  connections: number | null;
}

interface InstanceCore {
  actors: ActorSummary;
  objects: ObjectSummary;
  federation: FederationSummary;
  moderation: ModerationSummary;
  media: MediaSummary | null;
  cron: CronHealth;
  dlq: { recent: number; total: number };
  probeMs: number | null;
  streaming: StreamingHealth;
  durationMs: number;
}

async function readCronHealth(env: StatsEnv): Promise<CronHealth> {
  const [lastRaw, lockRaw] = await Promise.all([
    env.KV.get(CRON_LAST_KEY).catch(() => null),
    env.KV.get(CRON_LOCK_KEY).catch(() => null),
  ]);
  let lastRunAt: string | null = null;
  let lastDurationMs: number | null = null;
  if (lastRaw) {
    try {
      const parsed = JSON.parse(lastRaw) as { at?: string; duration_ms?: number };
      lastRunAt = parsed.at ?? null;
      lastDurationMs = typeof parsed.duration_ms === "number" ? parsed.duration_ms : null;
    } catch { /* a truncated marker is no marker */ }
  }
  let stage: string | null = null;
  if (lockRaw) {
    try {
      stage = (JSON.parse(lockRaw) as { stage?: string }).stage ?? null;
    } catch { /* ignore */ }
  }
  return { lastRunAt, lastDurationMs, stage };
}

/**
 * Deliveries that exhausted every retry in the last `withinMs`. The key format
 * is `dlq:delivery:<epoch ms>:<random>`, so the timestamps are read without
 * fetching a single value. The walk is bounded (5 pages of 1000) because this
 * runs behind the status API's KV cache, not per request.
 */
async function countRecentDeliveryFailures(
  env: StatsEnv,
  withinMs: number,
  now: number
): Promise<{ recent: number; total: number }> {
  if (!env.KV.list) return { recent: 0, total: 0 };
  let cursor: string | undefined;
  let recent = 0;
  let total = 0;
  for (let page = 0; page < 5; page++) {
    const listed = await env.KV
      .list({ prefix: DLQ_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) })
      .catch(() => null);
    if (!listed) break;
    for (const key of listed.keys) {
      total += 1;
      const stamp = Number.parseInt(key.name.slice(DLQ_PREFIX.length).split(":")[0] ?? "", 10);
      if (Number.isFinite(stamp) && now - stamp <= withinMs) recent += 1;
    }
    if (listed.list_complete || !listed.cursor) break;
    cursor = listed.cursor;
  }
  return { recent, total };
}

/** Round-trip time of a trivial D1 query; `null` when the probe itself failed. */
async function probeDatabase(db: D1Database): Promise<number | null> {
  const started = Date.now();
  try {
    await db.prepare("SELECT 1").first();
    return Date.now() - started;
  } catch {
    return null;
  }
}

/**
 * Ask the streaming Durable Object directly: a plain request wakes it (it may
 * be hibernating) and its `/health` branch answers with the open connection
 * count. A missing binding means the feature is not deployed here.
 */
async function probeStreaming(env: StatsEnv): Promise<StreamingHealth> {
  const namespace = env.TIMELINE_STREAM;
  if (!namespace) return { state: "disabled", connections: null };
  try {
    const stub = namespace.get(namespace.idFromName("timeline"));
    const response = await stub.fetch("https://timeline.internal/health");
    if (!response.ok) return { state: "down", connections: null };
    const body = (await response.json()) as { connections?: number };
    return { state: "operational", connections: typeof body.connections === "number" ? body.connections : null };
  } catch {
    return { state: "down", connections: null };
  }
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function readActorSummary(db: D1Database): Promise<ActorSummary> {
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN is_local = 1 THEN 1 ELSE 0 END) AS local,
         SUM(CASE WHEN is_local = 0 THEN 1 ELSE 0 END) AS remote,
         SUM(CASE WHEN suspended = 1 THEN 1 ELSE 0 END) AS suspended,
         SUM(CASE WHEN silenced = 1 AND suspended = 0 THEN 1 ELSE 0 END) AS limited,
         SUM(CASE WHEN memorial = 1 THEN 1 ELSE 0 END) AS memorial,
         SUM(CASE WHEN is_local = 1 AND (email_verified = 0 OR approved = 0) AND suspended = 0 THEN 1 ELSE 0 END) AS pending,
         MIN(CASE WHEN is_local = 1 THEN created_at END) AS first_local
       FROM actors`
    )
    .first<Record<string, number | string | null>>();
  return {
    local: num(row?.local),
    remote: num(row?.remote),
    suspended: num(row?.suspended),
    limited: num(row?.limited),
    memorial: num(row?.memorial),
    pending: num(row?.pending),
    firstLocalAt: typeof row?.first_local === "string" ? row.first_local : null,
  };
}

async function readObjectSummary(db: D1Database): Promise<ObjectSummary> {
  // One branch per value: each count walks `idx_objects_local_pub_actor`
  // (index-only) instead of scanning the table to evaluate a `CASE`.
  const rows = await db.batch<{ n: number }>([
    db.prepare("SELECT COUNT(*) AS n FROM objects WHERE is_local = 1"),
    db.prepare("SELECT COUNT(*) AS n FROM objects WHERE is_local = 0"),
    db.prepare("SELECT COUNT(*) AS n FROM objects WHERE is_local = 1 AND published >= datetime('now', '-1 day')"),
  ]);
  return {
    local: num(rows[0]?.results?.[0]?.n),
    remote: num(rows[1]?.results?.[0]?.n),
    local24h: num(rows[2]?.results?.[0]?.n),
  };
}

async function readFederationSummary(db: D1Database): Promise<FederationSummary> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM instances) AS domains,
         (SELECT COUNT(*) FROM instances WHERE unavailable = 1) AS unavailable,
         (SELECT MAX(published) FROM activities) AS last_activity,
         (SELECT COUNT(*) FROM follows f JOIN actors a ON a.id = f.target_id
           WHERE f.state = 'accepted' AND a.is_local = 0) AS remote_follows`
    )
    .first<Record<string, number | string | null>>();
  return {
    domains: num(row?.domains),
    unavailable: num(row?.unavailable),
    lastActivityAt: typeof row?.last_activity === "string" ? row.last_activity : null,
    remoteFollows: num(row?.remote_follows),
  };
}

async function readModerationSummary(db: D1Database): Promise<ModerationSummary> {
  const [open, decisions] = await db.batch<{ n: number }>([
    db.prepare("SELECT COUNT(*) AS n FROM reports WHERE action_taken = 0"),
    db.prepare("SELECT COUNT(*) AS n FROM moderation_log WHERE created_at >= datetime('now', '-1 day')"),
  ]);
  return {
    openReports: num(open?.results?.[0]?.n),
    decisions24h: num(decisions?.results?.[0]?.n),
  };
}

async function readMediaSummary(db: D1Database): Promise<MediaSummary | null> {
  const stats = await getMediaCacheStats(db).catch(() => null);
  if (!stats) return null;
  return {
    ready: stats.ready,
    pending: stats.pending,
    failed: stats.failed,
    bytes: stats.bytes,
    oldestFetchedAt: stats.oldestFetchedAt,
  };
}

/** SQLite writes `datetime('now')` without a zone; the status page needs an instant. */
function parseDbDate(value: string | null): number | null {
  if (!value) return null;
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function minutesSince(instant: number | null, now: number): number | null {
  if (instant === null) return null;
  return Math.max(0, Math.round((now - instant) / 60000));
}

/** Every source both views need, gathered in one round of parallel reads. */
async function collectCore(env: StatsEnv, now: number): Promise<InstanceCore> {
  const started = Date.now();
  const [actors, objects, federation, moderation, media, cron, dlq, probeMs, streaming] = await Promise.all([
    readActorSummary(env.DB),
    readObjectSummary(env.DB),
    readFederationSummary(env.DB),
    readModerationSummary(env.DB),
    readMediaSummary(env.DB),
    readCronHealth(env),
    countRecentDeliveryFailures(env, 24 * 3600_000, now),
    probeDatabase(env.DB),
    probeStreaming(env),
  ]);
  return {
    actors,
    objects,
    federation,
    moderation,
    media,
    cron,
    dlq,
    probeMs,
    streaming,
    durationMs: Math.max(0, Date.now() - started),
  };
}

/** Turn the collected data into the component list both surfaces render. */
function buildStatus(env: StatsEnv, now: number, core: InstanceCore): InstanceStatusSnapshot {
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const { actors, federation, media, cron, dlq, probeMs, streaming } = core;

  const activityMinutes = minutesSince(parseDbDate(federation.lastActivityAt), now);
  const lastRunAt = cron.lastRunAt ? Date.parse(cron.lastRunAt) : Number.NaN;
  const runMinutes = minutesSince(Number.isFinite(lastRunAt) ? lastRunAt : null, now);

  const components: StatusComponent[] = [
    // The web tier answers by definition (this snapshot was built by it); the
    // metric is how long building it took, which is what an operator watching
    // a slow instance wants to see.
    { key: "web", state: "operational", metrics: { latency_ms: core.durationMs } },
    {
      key: "database",
      state: databaseState(probeMs),
      metrics: { probe_ms: probeMs },
    },
    {
      key: "federation",
      state: federationState(activityMinutes, federation.remoteFollows),
      metrics: {
        domains: federation.domains,
        unavailable_domains: federation.unavailable,
        remote_follows: federation.remoteFollows,
        last_activity_minutes: activityMinutes,
      },
    },
    {
      key: "delivery",
      state: deliveryState(dlq.recent),
      metrics: { failures_24h: dlq.recent, failures_recorded: dlq.total },
    },
    {
      key: "media",
      state: mediaState({
        enabled: limits.mediaCacheEnabled,
        bytes: media?.bytes ?? 0,
        pending: media?.pending ?? 0,
        maxBytes: limits.mediaCacheMaxBytes,
        fetchBatch: limits.mediaCacheFetchBatch,
      }),
      metrics: {
        entries: media?.ready ?? 0,
        pending: media?.pending ?? 0,
        failed: media?.failed ?? 0,
        bytes: media?.bytes ?? 0,
        oldest_fetched_at: media?.oldestFetchedAt ?? null,
      },
    },
    { key: "streaming", state: streaming.state, metrics: { connections: streaming.connections } },
    {
      key: "maintenance",
      state: maintenanceState(runMinutes),
      metrics: { last_run_minutes: runMinutes, stage: cron.stage },
    },
  ];

  return {
    checked_at: new Date(now).toISOString(),
    version: env.INSTANCE_VERSION ?? "0.1.0",
    overall: summarizeOverall(components),
    components,
    metrics: {
      local_accounts: actors.local,
      remote_accounts: actors.remote,
      local_statuses: core.objects.local,
      statuses_24h: core.objects.local24h,
      domains: federation.domains,
      media_entries: media?.ready ?? 0,
      media_bytes: media?.bytes ?? 0,
      running_since: actors.firstLocalAt,
    },
  };
}

/** Everything a visitor may see: component states plus public counters. */
export async function getInstanceStatus(env: StatsEnv, now = Date.now()): Promise<InstanceStatusSnapshot> {
  return buildStatus(env, now, await collectCore(env, now));
}

export interface InstanceStatsSnapshot {
  status: InstanceStatusSnapshot;
  actors: ActorSummary;
  statuses: ObjectSummary;
  database: {
    bytes: number | null;
    measured_at: string | null;
    prunable_bytes: number;
    prunable_rows: number;
    measuring: boolean;
    retention: { days: number; max_bytes: number };
    rows: Record<string, number>;
  };
  federation: FederationSummary & {
    blocked_domains: number;
    relays: { accepted: number; pending: number; rejected: number; idle: number };
  };
  delivery: {
    permanent_failures: number;
    unreachable: number;
    last_ok_at: string | null;
    failures_24h: number;
    failures_recorded: number;
  };
  media: {
    enabled: boolean;
    ready: number;
    pending: number;
    failed: number;
    bytes: number;
    queue_due: number;
    oldest_fetched_at: string | null;
    config: { days: number; profile_days: number; max_bytes: number; fetch_batch: number; cold_days: number };
  };
  moderation: ModerationSummary & {
    pending_registrations: number;
    suspended: number;
    limited: number;
    memorial: number;
  };
  cron: CronHealth;
  features: {
    ai: boolean;
    vectorize: boolean;
    email: boolean;
    turnstile: boolean;
    page_cache: { enabled: boolean; ttl_seconds: number; swr_seconds: number };
    media_cache_enabled: boolean;
    retention: { days: number; max_bytes: number };
    registrations: { enabled: boolean; approval_required: boolean };
    anonymous_timelines: string;
  };
}

/** `env.VECTORIZE` has no local simulator: reading it can throw in tests. */
function hasVectorize(env: StatsEnv): boolean {
  try {
    return Boolean(env.VECTORIZE);
  } catch {
    return false;
  }
}

async function readRowCounts(db: D1Database): Promise<Record<string, number>> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM objects)        AS objects,
         (SELECT COUNT(*) FROM actors)         AS actors,
         (SELECT COUNT(*) FROM activities)     AS activities,
         (SELECT COUNT(*) FROM attachments)    AS attachments,
         (SELECT COUNT(*) FROM notifications)  AS notifications,
         (SELECT COUNT(*) FROM follows)        AS follows,
         (SELECT COUNT(*) FROM media_cache)    AS media_cache,
         (SELECT COUNT(*) FROM instances)      AS instances,
         (SELECT COUNT(*) FROM reports)        AS reports,
         (SELECT COUNT(*) FROM moderation_log) AS moderation_log`
    )
    .first<Record<string, number>>()
    .catch(() => null);
  const counts: Record<string, number> = {};
  for (const [table, value] of Object.entries(row ?? {})) counts[table] = num(value);
  return counts;
}

/**
 * Everything an administrator sees on top of the public status. The core is
 * collected once and both the component list and the detailed sections are
 * built from it, so the panel never contradicts the public page.
 */
export async function getInstanceStatsSnapshot(env: StatsEnv, now = Date.now()): Promise<InstanceStatsSnapshot> {
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const retention = storageRetentionLimitsFrom(limits);
  const core = await collectCore(env, now);
  const [rows, storage, relays, delivery, mediaQueue, blocks, regs, anonymous] = await Promise.all([
    readRowCounts(env.DB),
    readStorageRetentionStats(env).catch(() => null),
    env.DB
      .prepare("SELECT state, COUNT(*) AS n FROM relays GROUP BY state")
      .all<{ state: string; n: number }>()
      .catch(() => null),
    env.DB
      .prepare(
        `SELECT
           SUM(CASE WHEN status <> 0 THEN 1 ELSE 0 END) AS permanent,
           SUM(CASE WHEN status = 0 THEN 1 ELSE 0 END) AS unreachable,
           MAX(last_ok_at) AS last_ok_at
         FROM delivery_rejections`
      )
      .first<Record<string, number | string | null>>(),
    env.DB
      .prepare(
        "SELECT COUNT(*) AS n FROM media_cache WHERE status IN ('pending', 'failed') AND datetime(next_attempt_at) <= datetime('now')"
      )
      .first<{ n: number }>()
      .catch(() => null),
    env.DB.prepare("SELECT COUNT(*) AS n FROM instance_domain_blocks").first<{ n: number }>().catch(() => null),
    getRegistrationSettings(env.DB),
    getAnonymousTimelineAccess(env.DB),
  ]);

  const relayStates = new Map((relays?.results ?? []).map((row) => [row.state, num(row.n)]));
  const media = core.media;

  return {
    status: buildStatus(env, now, core),
    actors: core.actors,
    statuses: core.objects,
    database: {
      bytes: storage?.estimate.databaseBytes ?? null,
      measured_at: storage?.estimate.measuredAt ?? null,
      prunable_bytes: storage?.estimate.bytes ?? 0,
      prunable_rows: storage?.estimate.rows ?? 0,
      measuring: storage?.estimate.measuring ?? false,
      retention: { days: retention.days, max_bytes: retention.maxBytes },
      rows,
    },
    federation: {
      ...core.federation,
      blocked_domains: num(blocks?.n),
      relays: {
        accepted: relayStates.get("accepted") ?? 0,
        pending: relayStates.get("pending") ?? 0,
        rejected: relayStates.get("rejected") ?? 0,
        idle: relayStates.get("idle") ?? 0,
      },
    },
    delivery: {
      permanent_failures: num(delivery?.permanent),
      unreachable: num(delivery?.unreachable),
      last_ok_at: typeof delivery?.last_ok_at === "string" ? delivery.last_ok_at : null,
      failures_24h: core.dlq.recent,
      failures_recorded: core.dlq.total,
    },
    media: {
      enabled: limits.mediaCacheEnabled,
      ready: media?.ready ?? 0,
      pending: media?.pending ?? 0,
      failed: media?.failed ?? 0,
      bytes: media?.bytes ?? 0,
      queue_due: num(mediaQueue?.n),
      oldest_fetched_at: media?.oldestFetchedAt ?? null,
      config: {
        days: limits.mediaCacheDays,
        profile_days: limits.mediaCacheProfileDays,
        max_bytes: limits.mediaCacheMaxBytes,
        fetch_batch: limits.mediaCacheFetchBatch,
        cold_days: limits.mediaCacheColdDays,
      },
    },
    moderation: {
      ...core.moderation,
      pending_registrations: core.actors.pending,
      suspended: core.actors.suspended,
      limited: core.actors.limited,
      memorial: core.actors.memorial,
    },
    cron: core.cron,
    features: {
      ai: Boolean(env.AI),
      vectorize: hasVectorize(env),
      email: Boolean(env.EMAIL),
      turnstile: Boolean(env.TURNSTILE_SECRET),
      page_cache: {
        enabled: limits.pageCacheTtl > 0,
        ttl_seconds: limits.pageCacheTtl,
        swr_seconds: limits.pageCacheSwr,
      },
      media_cache_enabled: limits.mediaCacheEnabled,
      retention: { days: limits.dbRetentionDays, max_bytes: limits.dbRetentionMaxBytes },
      registrations: { enabled: regs.enabled, approval_required: regs.approvalRequired },
      anonymous_timelines: anonymous,
    },
  };
}
