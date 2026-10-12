import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyTestSchema, resetTestStorage } from "./helpers/db";
import { getAccountSuggestions } from "@/lib/db";

const db = env.DB;
const BASE = "https://local.example.test";

async function seedLocal(username: string): Promise<string> {
  const id = `${BASE}/users/${username}`;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, last_status_at)
       VALUES (?, ?, 'local.example.test', 'pub', 'priv', 1, 1, ?)`
    )
    .bind(id, username, new Date().toISOString())
    .run();
  return id;
}

async function seedRemote(id: string, followers: number): Promise<void> {
  const username = id.split("/").pop()!;
  const domain = new URL(id).hostname;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, is_local, discoverable, followers_count, last_status_at)
       VALUES (?, ?, ?, 'pub', 0, 1, ?, ?)`
    )
    .bind(id, username, domain, followers, new Date().toISOString())
    .run();
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
});

describe("suggestions on a small instance", () => {
  it("fills the list with popular fediverse accounts when the local pools are exhausted", async () => {
    const viewer = await seedLocal("viewer");
    await seedLocal("alice");
    await seedRemote("https://big.example/users/celebrity", 12000);
    await seedRemote("https://small.example/users/nobody", 12);

    const suggestions = await getAccountSuggestions(db, viewer, { limit: 20 });
    const byUsername = new Map(suggestions.map((s) => [s.actor.username, s.source]));

    // The local community still comes first…
    expect(byUsername.get("alice")).toBe("global");
    // …and the fediverse-wide pool fills what the local pools cannot.
    expect(byUsername.get("celebrity")).toBe("global");
  });

  it("keeps an account the viewer already follows out of every pool", async () => {
    const viewer = await seedLocal("viewer");
    await seedRemote("https://big.example/users/celebrity", 12000);
    await db
      .prepare("INSERT INTO follows (id, actor_id, target_id, state) VALUES ('f1', ?, 'https://big.example/users/celebrity', 'accepted')")
      .bind(viewer)
      .run();

    const suggestions = await getAccountSuggestions(db, viewer, { limit: 20 });

    expect(suggestions.map((s) => s.actor.username)).not.toContain("celebrity");
  });
});
