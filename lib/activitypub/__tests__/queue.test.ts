// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { APDeliveryMessage } from "@/lib/activitypub/queue";

const deliverToInbox = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true, status: 200 }));

vi.mock("@/lib/activitypub/federation", () => ({ deliverToInbox, signedGetHeaders: vi.fn().mockResolvedValue({}) }));

import { enqueueDeliveries, resolveDeliverySigningKey } from "@/lib/activitypub/queue";

describe("enqueueDeliveries", () => {
  beforeEach(() => {
    deliverToInbox.mockClear();
  });

  it("uses queue.sendBatch and de-duplicates inboxes", async () => {
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const queue = { sendBatch } as unknown as Parameters<typeof enqueueDeliveries>[0];
    await enqueueDeliveries(
      queue,
      ["https://a.example/inbox", "https://a.example/inbox", "https://b.example/inbox"],
      JSON.stringify({ type: "Create" }),
      "https://local.example/users/alice",
      "https://local.example/users/alice#main-key",
      "pem"
    );
    expect(sendBatch).toHaveBeenCalledTimes(1);
    const batch = sendBatch.mock.calls[0][0] as { body: APDeliveryMessage }[];
    expect(batch).toHaveLength(2);
    expect(deliverToInbox).not.toHaveBeenCalled();
  });

  it("chunks more than 100 recipients into multiple sendBatch calls", async () => {
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const queue = { sendBatch } as unknown as Parameters<typeof enqueueDeliveries>[0];
    const inboxes = Array.from({ length: 250 }, (_, i) => `https://h${i}.example/inbox`);

    await enqueueDeliveries(
      queue,
      inboxes,
      JSON.stringify({ type: "Create" }),
      "https://local.example/users/alice",
      "https://local.example/users/alice#main-key",
      "pem"
    );

    expect(sendBatch).toHaveBeenCalledTimes(3);
    const sizes = sendBatch.mock.calls.map((c) => (c[0] as unknown[]).length);
    expect(sizes).toEqual([100, 100, 50]);
    const delivered = new Set(
      sendBatch.mock.calls.flatMap((c) => (c[0] as { body: APDeliveryMessage }[]).map((m) => m.body.inboxUrl))
    );
    expect(delivered.size).toBe(250);
    expect(deliverToInbox).not.toHaveBeenCalled();
  });

  it("retries a transient sendBatch failure before giving up", async () => {
    const sendBatch = vi.fn()
      .mockRejectedValueOnce(new Error("Too Many Requests"))
      .mockResolvedValueOnce(undefined);
    const queue = { sendBatch } as unknown as Parameters<typeof enqueueDeliveries>[0];

    await enqueueDeliveries(
      queue,
      ["https://a.example/inbox"],
      JSON.stringify({ type: "Create" }),
      "https://local.example/users/alice",
      "https://local.example/users/alice#main-key",
      "pem"
    );

    expect(sendBatch).toHaveBeenCalledTimes(2);
    expect(deliverToInbox).not.toHaveBeenCalled();
  });

  it("falls back to direct delivery only for the chunk that keeps failing", async () => {
    let call = 0;
    const sendBatch = vi.fn().mockImplementation(() => {
      call += 1;
      // The second chunk (calls 2-4, three attempts) fails; the others succeed.
      if (call === 2 || call === 3 || call === 4) return Promise.reject(new Error("boom"));
      return Promise.resolve();
    });
    const queue = { sendBatch } as unknown as Parameters<typeof enqueueDeliveries>[0];
    const inboxes = Array.from({ length: 250 }, (_, i) => `https://h${i}.example/inbox`);

    await enqueueDeliveries(
      queue,
      inboxes,
      JSON.stringify({ type: "Create" }),
      "https://local.example/users/alice",
      "https://local.example/users/alice#main-key",
      "pem"
    );

    // 1st chunk: 1 call. 2nd chunk: 3 attempts (all fail) → direct for its 100.
    // 3rd chunk: 1 call.
    expect(sendBatch).toHaveBeenCalledTimes(5);
    expect(deliverToInbox).toHaveBeenCalledTimes(100);
  });

  it("delivers an oversized activity directly instead of dropping it", async () => {
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const queue = { sendBatch } as unknown as Parameters<typeof enqueueDeliveries>[0];
    const huge = JSON.stringify({ type: "Create", content: "x".repeat(140 * 1024) });

    await enqueueDeliveries(
      queue,
      ["https://a.example/inbox", "https://b.example/inbox"],
      huge,
      "https://local.example/users/alice",
      "https://local.example/users/alice#main-key",
      "pem"
    );

    expect(deliverToInbox).toHaveBeenCalledTimes(2);
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("delivers directly only when no queue binding exists", async () => {
    await enqueueDeliveries(
      undefined,
      ["https://a.example/inbox"],
      JSON.stringify({ type: "Create" }),
      "https://local.example/users/alice",
      "https://local.example/users/alice#main-key",
      "pem"
    );
    expect(deliverToInbox).toHaveBeenCalledTimes(1);
  });

  it("does nothing for an empty inbox list", async () => {
    const sendBatch = vi.fn();
    await enqueueDeliveries({ sendBatch } as never, [], "{}", "actor", "key", "pem");
    expect(sendBatch).not.toHaveBeenCalled();
    expect(deliverToInbox).not.toHaveBeenCalled();
  });
});

describe("resolveDeliverySigningKey", () => {
  const ACTOR = "https://local.example/users/alice";

  /** Fake D1 + KV pair: the row is what the DB holds, `kv` what KV holds. */
  function fakeEnv(row: { private_key_pem: string } | null, kv?: string | null) {
    const get = vi.fn().mockResolvedValue(kv ?? null);
    return {
      get,
      env: {
        DB: {
          prepare: () => ({ bind: () => ({ first: async () => row }) }),
        },
        ...(kv === undefined && !row ? {} : { KV: { get } }),
      } as unknown as Parameters<typeof resolveDeliverySigningKey>[0],
    };
  }

  it("prefers the live actor row", async () => {
    const { env, get } = fakeEnv({ private_key_pem: "live-pem" }, JSON.stringify({ privateKeyPem: "stale-pem" }));
    await expect(resolveDeliverySigningKey(env, ACTOR)).resolves.toEqual({
      keyId: `${ACTOR}#main-key`,
      privateKeyPem: "live-pem",
    });
    // The row is canonical: a stale grace entry is never even read.
    expect(get).not.toHaveBeenCalled();
  });

  it("falls back to the KV grace entry for a just-deleted actor", async () => {
    const { env } = fakeEnv(
      null,
      JSON.stringify({ keyId: `${ACTOR}#main-key`, privateKeyPem: "parked-pem" })
    );
    await expect(resolveDeliverySigningKey(env, ACTOR)).resolves.toEqual({
      keyId: `${ACTOR}#main-key`,
      privateKeyPem: "parked-pem",
    });
  });

  it("returns null when neither the row nor a grace entry exists", async () => {
    const { env } = fakeEnv(null, null);
    await expect(resolveDeliverySigningKey(env, ACTOR)).resolves.toBeNull();
  });

  it("returns null for a malformed grace entry", async () => {
    const { env } = fakeEnv(null, "not-json");
    await expect(resolveDeliverySigningKey(env, ACTOR)).resolves.toBeNull();
  });

  it("returns null when there is no KV binding", async () => {
    const env = {
      DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
    } as unknown as Parameters<typeof resolveDeliverySigningKey>[0];
    await expect(resolveDeliverySigningKey(env, ACTOR)).resolves.toBeNull();
  });
});
