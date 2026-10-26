// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { atomicRateLimit, countHit, type RateLimitStorage } from "@/lib/rate-limit";

/** In-memory stand-in for the DO's strongly-consistent storage. */
function fakeStorage(): RateLimitStorage & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    async get<T>(key: string): Promise<T | undefined> {
      return store.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
  };
}

describe("countHit (RateLimitDO core)", () => {
  it("allows up to max hits inside one window and denies the rest", async () => {
    const storage = fakeStorage();
    const now = 1_800_000_030; // fixed instant inside a 60s window
    expect((await countHit(storage, 3, 60, now)).allowed).toBe(true);
    expect((await countHit(storage, 3, 60, now + 1)).allowed).toBe(true);
    const third = await countHit(storage, 3, 60, now + 2);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
    const fourth = await countHit(storage, 3, 60, now + 3);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfter).toBeGreaterThan(0);
  });

  it("starts a fresh budget when the window rolls over", async () => {
    const storage = fakeStorage();
    const now = 1_800_000_030;
    await countHit(storage, 1, 60, now);
    expect((await countHit(storage, 1, 60, now + 1)).allowed).toBe(false);
    const nextWindow = Math.floor(now / 60) * 60 + 60;
    expect((await countHit(storage, 1, 60, nextWindow + 1)).allowed).toBe(true);
  });

  it("counts every hit exactly once when requests are serialized (the DO guarantee)", async () => {
    const storage = fakeStorage();
    const now = 1_800_000_030;
    // RateLimitDO processes one request at a time (Durable Object input
    // serialization), so the hits arrive sequentially — unlike the KV get→put
    // counter, no burst can read the same stale count.
    let allowedCount = 0;
    for (let i = 0; i < 10; i++) {
      const decision = await countHit(storage, 5, 60, now + i);
      if (decision.allowed) allowedCount++;
    }
    expect(allowedCount).toBe(5);
    expect(storage.store.get(`w:${Math.floor(now / 60)}`)).toBe(10);
  });
});

describe("atomicRateLimit", () => {
  function fakeKv() {
    const store = new Map<string, string>();
    return {
      store,
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      put: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
      delete: vi.fn(async (k: string) => { store.delete(k); }),
      list: vi.fn(),
    };
  }

  it("uses the Durable Object when the binding exists", async () => {
    const stubFetch = vi.fn(async () =>
      new Response(JSON.stringify({ allowed: false, remaining: 0, retryAfter: 42 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const ns = {
      idFromName: vi.fn(() => ({})),
      get: vi.fn(() => ({ fetch: stubFetch })),
    };
    const decision = await atomicRateLimit(
      { RATE_LIMIT: ns as never, KV: fakeKv() as never },
      "login:ip:1.2.3.4",
      10,
      60
    );
    expect(ns.idFromName).toHaveBeenCalledWith("login:ip:1.2.3.4");
    expect(decision).toEqual({ allowed: false, remaining: 0, retryAfter: 42 });
  });

  it("falls back to the KV counter without the binding", async () => {
    const kv = fakeKv();
    const decision = await atomicRateLimit({ KV: kv as never }, "k", 2, 60);
    expect(decision.allowed).toBe(true);
    expect(kv.put).toHaveBeenCalled();
  });

  it("falls back to the KV counter when the DO fetch throws", async () => {
    const kv = fakeKv();
    const ns = {
      idFromName: vi.fn(() => ({})),
      get: vi.fn(() => ({ fetch: vi.fn(async () => { throw new Error("boom"); }) })),
    };
    const decision = await atomicRateLimit({ RATE_LIMIT: ns as never, KV: kv as never }, "k", 2, 60);
    expect(decision.allowed).toBe(true);
    expect(kv.put).toHaveBeenCalled();
  });

  it("fails open when nothing is configured (a limiter must not brick a route)", async () => {
    const decision = await atomicRateLimit({}, "k", 2, 60);
    expect(decision.allowed).toBe(true);
  });
});
