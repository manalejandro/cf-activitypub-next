// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { APDeliveryMessage } from "@/lib/activitypub/queue";

const deliverToInbox = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true, status: 200 }));

vi.mock("@/lib/activitypub/federation", () => ({ deliverToInbox }));

import { enqueueDeliveries } from "@/lib/activitypub/queue";

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
