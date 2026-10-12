import { beforeAll, beforeEach, describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { applyTestSchema, resetTestStorage } from "./helpers/db";
import { resolveMentionLinks } from "@/lib/activitypub/mentions";

const BASE = "https://local.example.test";

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
});

describe("resolveMentionLinks", () => {
  it("links only the local accounts that exist", async () => {
    await env.DB
      .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?,?,?,?,1)")
      .bind(`${BASE}/users/alice`, "alice", "local.example.test", "pub")
      .run();

    const links = await resolveMentionLinks(env.DB, "hola @alice y @algo", BASE, env.KV);

    expect(links.get("alice")?.href).toBe(`${BASE}/users/alice`);
    expect(links.get("alice@local.example.test")?.href).toBe(`${BASE}/users/alice`);
    // `@algo` does not exist: it must stay plain text, not a dead profile link.
    expect(links.has("algo")).toBe(false);
    expect(links.size).toBe(2);
  });

  it("resolves a cached remote actor without a network round trip", async () => {
    await env.DB
      .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?,?,?,?,0)")
      .bind("https://remote.example/users/bob", "bob", "remote.example", "pub")
      .run();

    const links = await resolveMentionLinks(env.DB, "hola @bob@remote.example", BASE, env.KV);

    expect(links.get("bob@remote.example")?.href).toBe("https://remote.example/users/bob");
  });
});
