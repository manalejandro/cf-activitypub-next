import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

const resolveMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/activitypub/remote", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/activitypub/remote")>()),
  fetchAndCacheRemoteActor: resolveMock,
}));

import { canonicalizeMentionTags } from "@/lib/activitypub/mentions";

const db = env.DB;
const CFAP = "https://cf-ap.com/users/manalejandro";

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestDatabase();
  resolveMock.mockReset();
  await db
    .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?,?,?,'k',0)")
    .bind(CFAP, "manalejandro", "cf-ap.com")
    .run();
});

describe("canonicalizeMentionTags", () => {
  it("rewrites a web-profile href to the cached actor IRI without fetching", async () => {
    const result = await canonicalizeMentionTags(db, [
      { type: "Mention", href: "https://cf-ap.com/@manalejandro", name: "@manalejandro@cf-ap.com" },
    ]);

    expect(result.tags[0].href).toBe(CFAP);
    expect(result.rewrites.get("https://cf-ap.com/@manalejandro")).toBe(CFAP);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("resolves unknown handles through the hardened actor resolver", async () => {
    resolveMock.mockResolvedValue({
      id: "https://other.example/users/nueva",
      inbox: "https://other.example/inbox",
      domain: "other.example",
    });

    const result = await canonicalizeMentionTags(db, [
      { type: "Mention", href: "https://other.example/@nueva", name: "@nueva@other.example" },
    ]);

    expect(result.tags[0].href).toBe("https://other.example/users/nueva");
    const calls = resolveMock.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe("https://other.example/@nueva");
  });

  it("keeps the profile URL when the actor cannot be resolved", async () => {
    resolveMock.mockResolvedValue(null);

    const result = await canonicalizeMentionTags(db, [
      { type: "Mention", href: "https://unknown.example/@ghost", name: "@ghost@unknown.example" },
    ]);

    expect(result.tags[0].href).toBe("https://unknown.example/@ghost");
    expect(result.rewrites.size).toBe(0);
  });

  it("leaves actor IRIs and non-mention tags untouched", async () => {
    const result = await canonicalizeMentionTags(db, [
      { type: "Mention", href: "https://local.example/users/alice", name: "@alice@local.example" },
      { type: "Hashtag", href: "https://local.example/tags/x", name: "#x" },
    ]);

    expect(result.tags.map((tag) => tag.href)).toEqual([
      "https://local.example/users/alice",
      "https://local.example/tags/x",
    ]);
    expect(resolveMock).not.toHaveBeenCalled();
  });
});
