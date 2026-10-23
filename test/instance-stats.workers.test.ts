import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

import {
  CRON_LAST_KEY,
  DLQ_PREFIX,
  MEDIA_BACKLOG_FACTOR,
  getInstanceStatsSnapshot,
  getInstanceStatus,
} from "@/lib/instance-stats";
import { GET as getPublicStatus } from "@/app/api/v1/status/route";
import { resolveLimits } from "@/lib/constants";
import { GET as getAdminStats } from "@/app/api/v1/admin/stats/route";

const db = env.DB;
const LOCAL = "https://local.example/users/bob";
const REMOTE = "https://remote.example/users/alice";
/** Fixed clock: the thresholds are minutes and the tests must not race them. */
const NOW = Date.parse("2026-10-22T12:00:00.000Z");

function stateOf(snapshot: { components: { key: string; state: string }[] }, key: string): string | undefined {
  return snapshot.components.find((component) => component.key === key)?.state;
}

async function seedActors(): Promise<void> {
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, email, email_verified, created_at)
       VALUES (?, 'alice', 'remote.example', 'pub', NULL, 0, 1, 'alice@remote.example', 1, '2026-01-05 10:00:00'),
              (?, 'bob', 'local.example', 'pub', 'priv', 1, 1, 'bob@local.example', 1, '2026-02-01 09:30:00')`
    )
    .bind(REMOTE, LOCAL)
    .run();
}

async function seedActivity(published: Date): Promise<void> {
  await db
    .prepare(
      `INSERT INTO activities (id, type, actor_id, published, raw)
       VALUES (?, 'Create', ?, ?, '{}')`
    )
    .bind(`https://remote.example/activities/${published.getTime()}`, REMOTE, published.toISOString().replace("T", " ").slice(0, 19))
    .run();
}

async function seedLocalObject(id: string, published: Date): Promise<void> {
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, published, updated_at, is_local)
       VALUES (?, 'Note', ?, 'hola', 'public', ?, ?, 1)`
    )
    .bind(id, LOCAL, published.toISOString().replace("T", " ").slice(0, 19), published.toISOString().replace("T", " ").slice(0, 19))
    .run();
}

async function markCronRun(at: Date): Promise<void> {
  await env.KV.put(CRON_LAST_KEY, JSON.stringify({ at: at.toISOString(), duration_ms: 1234 }));
}

async function recordDeliveryFailures(count: number, at: Date): Promise<void> {
  for (let index = 0; index < count; index++) {
    await env.KV.put(`${DLQ_PREFIX}${at.getTime() + index}:x${index}`, JSON.stringify({ at: at.toISOString() }), {
      expirationTtl: 30 * 86400,
    });
  }
}

async function seedPendingMedia(count: number, offset = 0): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < count; index++) {
    const id = offset + index;
    statements.push(
      db
        .prepare(
          `INSERT INTO media_cache (id, source_url, target_type, status, next_attempt_at)
           VALUES (?, ?, 'attachment', 'pending', datetime('now', '-1 minute'))`
        )
        .bind(`entry-${id}`, `https://remote.example/media/${id}.jpg`)
    );
  }
  await db.batch(statements);
}

/** A local account following a remote one: the graph inbound activity comes from. */
async function seedRemoteFollow(): Promise<void> {
  await db
    .prepare(
      `INSERT INTO follows (id, actor_id, target_id, state)
       VALUES ('follow-1', ?, ?, 'accepted')`
    )
    .bind(LOCAL, REMOTE)
    .run();
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
});

describe("instance status", () => {
  it("reports a bare instance without inventing trouble", async () => {
    const snapshot = await getInstanceStatus(env, NOW);

    expect(snapshot.overall).toBe("operational");
    expect(stateOf(snapshot, "web")).toBe("operational");
    expect(stateOf(snapshot, "database")).toBe("operational");
    // No remote accounts: nothing can be "lost", so federation is fine.
    expect(stateOf(snapshot, "federation")).toBe("operational");
    expect(stateOf(snapshot, "delivery")).toBe("operational");
    expect(stateOf(snapshot, "media")).toBe("operational");
    // A real probe against the streaming Durable Object.
    expect(stateOf(snapshot, "streaming")).toBe("operational");
    // No cron marker yet: the honest answer is "unknown", not green.
    expect(stateOf(snapshot, "maintenance")).toBe("unknown");
    expect(snapshot.metrics.local_accounts).toBe(0);
    expect(snapshot.metrics.running_since).toBeNull();
    expect(snapshot.version).toBe(env.INSTANCE_VERSION ?? "0.1.0");
  });

  it("counts the public metrics and the oldest local account", async () => {
    await seedActors();
    // The "last 24 h" counts run in SQL against the database clock
    // (`datetime('now')`), not against the fixed NOW the component thresholds
    // use, so these fixtures must be relative to the real clock — a hard-coded
    // date silently ages out of the window a day later.
    await seedLocalObject("https://local.example/objects/1", new Date(Date.now() - 3600_000));
    await seedLocalObject("https://local.example/objects/old", new Date(Date.now() - 10 * 86400_000));

    const snapshot = await getInstanceStatus(env, NOW);
    expect(snapshot.metrics.local_accounts).toBe(1);
    expect(snapshot.metrics.remote_accounts).toBe(1);
    expect(snapshot.metrics.local_statuses).toBe(2);
    expect(snapshot.metrics.statuses_24h).toBe(1);
    expect(snapshot.metrics.running_since).toBe("2026-02-01 09:30:00");
  });

  it("degrades federation only when a graph this instance follows goes stale", async () => {
    await seedActors();
    // Browsing remote profiles caches actors but expects nothing in return.
    await seedActivity(new Date(NOW - 5 * 86400_000));
    expect(stateOf(await getInstanceStatus(env, NOW), "federation")).toBe("operational");

    await seedRemoteFollow();
    // A remote follow with nothing inbound for days is a real signal.
    const stale = await getInstanceStatus(env, NOW);
    expect(stateOf(stale, "federation")).toBe("degraded");
    expect(stale.overall).toBe("degraded");

    await db.prepare("DELETE FROM activities").run();
    await seedActivity(new Date(NOW - 2 * 3600_000));
    expect(stateOf(await getInstanceStatus(env, NOW), "federation")).toBe("operational");
  });

  it("follows the cron's liveness marker", async () => {
    await markCronRun(new Date(NOW - 2 * 60_000));
    expect(stateOf(await getInstanceStatus(env, NOW), "maintenance")).toBe("operational");

    await markCronRun(new Date(NOW - 30 * 60_000));
    expect(stateOf(await getInstanceStatus(env, NOW), "maintenance")).toBe("degraded");

    // The TTL is two days: a marker older than the stale window means the cron
    // is not running, and the page says so.
    await markCronRun(new Date(NOW - 3 * 3600_000));
    const down = await getInstanceStatus(env, NOW);
    expect(stateOf(down, "maintenance")).toBe("down");
    expect(down.overall).toBe("down");
  });

  it("derives delivery health from the dead-letter log, ignoring old failures", async () => {
    await recordDeliveryFailures(2, new Date(NOW - 3600_000));
    // A failure from last month is history, not a current problem.
    await recordDeliveryFailures(1, new Date(NOW - 40 * 86400_000));
    expect(stateOf(await getInstanceStatus(env, NOW), "delivery")).toBe("operational");

    await recordDeliveryFailures(3, new Date(NOW - 60_000));
    const degraded = await getInstanceStatus(env, NOW);
    expect(stateOf(degraded, "delivery")).toBe("degraded");
    const delivery = degraded.components.find((component) => component.key === "delivery");
    expect(delivery?.metrics.failures_24h).toBe(5);

    await recordDeliveryFailures(5, new Date(NOW - 30_000));
    expect(stateOf(await getInstanceStatus(env, NOW), "delivery")).toBe("down");
  });

  it("flags a media-cache backlog over a few cron batches", async () => {
    const batch = resolveLimits(env as unknown as Record<string, unknown>).mediaCacheFetchBatch;
    await seedPendingMedia(batch * MEDIA_BACKLOG_FACTOR);
    expect(stateOf(await getInstanceStatus(env, NOW), "media")).toBe("operational");

    await seedPendingMedia(1, batch * MEDIA_BACKLOG_FACTOR + 100);
    const degraded = await getInstanceStatus(env, NOW);
    expect(stateOf(degraded, "media")).toBe("degraded");
    const media = degraded.components.find((component) => component.key === "media");
    expect(media?.metrics.pending).toBe(batch * MEDIA_BACKLOG_FACTOR + 1);
  });
});

describe("public status endpoint", () => {
  it("serves the snapshot from the KV cache", async () => {
    const marker = JSON.stringify({ checked_at: "2026-10-22T12:00:00.000Z", overall: "operational", components: [], metrics: {} });
    await env.KV.put("status:snapshot", marker);

    const response = await getPublicStatus();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.text()).toBe(marker);
  });

  it("computes and caches the snapshot when there is none", async () => {
    await seedActors();
    const first = await getPublicStatus();
    expect(first.status).toBe(200);
    const body = (await first.json()) as { overall: string; components: { key: string }[] };
    expect(body.components.map((component) => component.key)).toContain("federation");
    expect(await env.KV.get("status:snapshot")).not.toBeNull();
  });
});

describe("admin statistics endpoint", () => {
  it("refuses anonymous callers and serves administrators", async () => {
    const anonymous = await getAdminStats(new NextRequest("http://local.example/api/v1/admin/stats"));
    expect(anonymous.status).toBe(401);

    await seedActors();
    await db.prepare("UPDATE actors SET role = 'admin' WHERE id = ?").bind(LOCAL).run();
    await db
      .prepare(
        `INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at)
         VALUES ('t-admin-stats', ?, NULL, 'tok-admin-stats', 'read write', datetime('now'))`
      )
      .bind(LOCAL)
      .run();

    const response = await getAdminStats(
      new NextRequest("http://local.example/api/v1/admin/stats", {
        headers: { Authorization: "Bearer tok-admin-stats" },
      })
    );
    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as {
      status: { overall: string; components: { key: string }[] };
      database: { rows: Record<string, number>; retention: { days: number } };
      media: { config: { max_bytes: number } };
      federation: { relays: { accepted: number } };
      features: { page_cache: { ttl_seconds: number }; registrations: { enabled: boolean } };
      moderation: { openReports: number };
    };
    expect(snapshot.status.components.map((component) => component.key)).toContain("database");
    expect(snapshot.database.rows.actors).toBe(2);
    expect(snapshot.database.rows.objects).toBe(0);
    expect(snapshot.features.page_cache.ttl_seconds).toBe(60);
    expect(snapshot.media.config.max_bytes).toBeGreaterThan(0);
    expect(snapshot.federation.relays.accepted).toBe(0);
    expect(snapshot.moderation.openReports).toBe(0);
  });

  it("keeps the detailed sections consistent with the public status", async () => {
    await seedActors();

    const detailed = await getInstanceStatsSnapshot(env, NOW);
    expect(detailed.status.overall).toBe("operational");
    expect(detailed.actors.local).toBe(1);
    expect(detailed.actors.remote).toBe(1);
    expect(detailed.actors.pending).toBe(0);
    // The component list the admin panel renders is the same one the public
    // page renders: same source, no second opinion. (Latency and probe times
    // are measured per call, so the comparison is key and state.)
    const pairs = (components: { key: string; state: string }[]) => components.map((c) => [c.key, c.state]);
    expect(pairs(detailed.status.components)).toEqual(pairs((await getInstanceStatus(env, NOW)).components));
  });
});
