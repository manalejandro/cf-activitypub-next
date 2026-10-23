// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { createCronSchedule, CRON_SCHEDULE_KEY } from "@/lib/cron-schedule";

/** In-memory KV that counts the round trips. */
function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const gets: string[] = [];
  const puts: string[] = [];
  return {
    store,
    gets,
    puts,
    kv: {
      get: vi.fn(async (key: string) => {
        gets.push(key);
        return store.get(key) ?? null;
      }),
      put: vi.fn(async (key: string, value: string) => {
        puts.push(key);
        store.set(key, value);
      }),
    },
  };
}

describe("createCronSchedule", () => {
  it("always runs the minute-resolution stages", async () => {
    const { kv, gets } = fakeKv();
    const schedule = createCronSchedule(kv);
    for (let i = 0; i < 5; i++) {
      expect(await schedule.every("scheduled", 1)).toBe(true);
      expect(await schedule.every("media-release", 1)).toBe(true);
    }
    // …and never touches KV for them: the punctual stages must not pay a read.
    expect(gets).toHaveLength(0);
  });

  it("runs a stage once per interval", async () => {
    const { kv } = fakeKv();
    let clock = 1_000_000;
    const schedule = createCronSchedule(kv, () => clock);

    expect(await schedule.every("media-queue", 2)).toBe(true);
    expect(await schedule.every("media-queue", 2)).toBe(false);
    clock += 60_000; // one minute later
    expect(await schedule.every("media-queue", 2)).toBe(false);
    clock += 60_000; // two minutes since the last run
    expect(await schedule.every("media-queue", 2)).toBe(true);
  });

  it("shares one KV read across the whole tick and writes only when due", async () => {
    const { kv, gets, puts } = fakeKv();
    const schedule = createCronSchedule(kv);

    // First tick: several stages are due, the rest are not.
    expect(await schedule.every("auto-delete", 5)).toBe(true);
    expect(await schedule.every("guardian", 5)).toBe(true);
    expect(await schedule.every("verify", 15)).toBe(true);
    expect(gets).toHaveLength(1);
    expect(puts).toHaveLength(3);

    // A tick a minute later: nothing is due, and the state is still in memory.
    let clock = Date.now() + 60_000;
    const next = createCronSchedule(kv, () => clock);
    expect(await next.every("auto-delete", 5)).toBe(false);
    expect(await next.every("guardian", 5)).toBe(false);
    expect(await next.every("verify", 15)).toBe(false);
    // The read happens once per run, not once per stage.
    expect(gets).toHaveLength(2);

    clock += 4 * 60_000;
    const later = createCronSchedule(kv, () => clock);
    expect(await later.every("auto-delete", 5)).toBe(true);
    expect(await later.every("verify", 15)).toBe(false);
  });

  it("keeps the stages apart", async () => {
    const { kv, store } = fakeKv();
    const schedule = createCronSchedule(kv);
    await schedule.every("polls", 3);

    const state = JSON.parse(store.get(CRON_SCHEDULE_KEY) ?? "{}") as Record<string, number>;
    expect(Object.keys(state)).toEqual(["polls"]);
    expect(state.polls).toBeGreaterThan(0);
    expect(schedule.snapshot()).toMatchObject({ polls: state.polls });
  });

  it("starts the schedule over when the stored entry is truncated", async () => {
    const { kv } = fakeKv({ [CRON_SCHEDULE_KEY]: "{not json" });
    const schedule = createCronSchedule(kv);
    // A broken entry must not stall every stage forever.
    expect(await schedule.every("storage-retention", 10)).toBe(true);
  });

  it("ignores garbage values inside the entry", async () => {
    const { kv } = fakeKv({ [CRON_SCHEDULE_KEY]: JSON.stringify({ polls: "ayer", verify: 12345 }) });
    const schedule = createCronSchedule(kv);
    // "ayer" is not a timestamp: the stage runs instead of waiting forever.
    expect(await schedule.every("polls", 3)).toBe(true);
    const snapshot = schedule.snapshot();
    expect(snapshot.verify).toBe(12345);
    expect(typeof snapshot.polls).toBe("number");
  });
});

/**
 * The cadence lives in `src/worker.ts` as one line per stage. Reading the source
 * keeps this table and the code from drifting: adding a stage without an
 * interval (the old "everything every minute" tick) fails here.
 */
describe("cron wiring in the worker", () => {
  const source = readFileSync(new URL("../../src/worker.ts", import.meta.url), "utf8");

  const CADENCE: Record<string, number> = {
    // Punctual: a scheduled status must go out on time, and held statuses must
    // be released as soon as their media lands.
    // (they call setStage without `schedule.every`)
    "auto-delete": 5,
    guardian: 5,
    expiration: 15,
    suggestions: 30,
    instances: 5,
    "shared-inbox": 5,
    polls: 3,
    "link-preview": 2,
    "storage-retention": 10,
    quotes: 10,
    verify: 15,
    oauth: 10,
    "media-maintenance": 5,
    "media-licenses": 10,
    "media-queue": 2,
    "media-backfill": 10,
    "media-repair": 10,
  };

  it("declares the documented interval for every background stage", () => {
    for (const [stage, minutes] of Object.entries(CADENCE)) {
      expect(source, `${stage} should run every ${minutes} min`).toContain(`schedule.every("${stage}", ${minutes})`);
    }
  });

  it("keeps the punctual stages punctual", () => {
    expect(source).toContain('await setStage("scheduled")');
    expect(source).not.toMatch(/schedule\.every\("(scheduled|media-release)"/);
    // Every stage still announces itself in the lock (the status page reads it).
    expect(source).toContain('await setStage("media-cache")');
  });

  it("runs the maintenance behind a single KV read per tick", () => {
    // One marker object, not one key per stage: the tick must stay cheap.
    expect(source).toContain("createCronSchedule(env.KV)");
  });
});
