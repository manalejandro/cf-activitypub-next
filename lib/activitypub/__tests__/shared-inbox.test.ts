// @vitest-environment node
import { describe, it, expect } from "vitest";
import { collectFollowerInboxes } from "@/lib/activitypub/federation";
import type { APActor } from "@/lib/types";

function actor(id: string, sharedInbox?: string): APActor {
  return {
    id,
    type: "Person",
    preferredUsername: "x",
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    followers: `${id}/followers`,
    following: `${id}/following`,
    publicKey: { id: `${id}#main-key`, owner: id, publicKeyPem: "k" },
    ...(sharedInbox ? { endpoints: { sharedInbox } } : {}),
  } as APActor;
}

describe("collectFollowerInboxes", () => {
  it("prefers the shared inbox and dedupes it across actors", async () => {
    const inboxes = await collectFollowerInboxes(["a1", "a2", "b1"], async (id) =>
      id.startsWith("a")
        ? actor("https://a.example/users/x", "https://a.example/inbox")
        : actor("https://b.example/users/y")
    );
    expect(inboxes.sort()).toEqual([
      "https://a.example/inbox",
      "https://b.example/users/y/inbox",
    ]);
  });

  it("falls back to the per-user inbox when no shared inbox is advertised", async () => {
    const inboxes = await collectFollowerInboxes(["a1"], async () => actor("https://a.example/users/x"));
    expect(inboxes).toEqual(["https://a.example/users/x/inbox"]);
  });

  it("skips actors that cannot be resolved", async () => {
    const inboxes = await collectFollowerInboxes(["a1", "missing"], async (id) =>
      id === "missing" ? null : actor("https://a.example/users/x", "https://a.example/inbox")
    );
    expect(inboxes).toEqual(["https://a.example/inbox"]);
  });
});
