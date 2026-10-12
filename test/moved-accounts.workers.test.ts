import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyTestSchema, resetTestStorage } from "./helpers/db";
import { getAccountSuggestions } from "@/lib/db";
import { GET as DIRECTORY_GET } from "@/app/api/v1/directory/route";
import { NextRequest } from "next/server";

const db = env.DB;
const BASE = "https://local.example.test";

async function seedLocal(username: string, movedTo: string | null = null): Promise<string> {
  const id = `${BASE}/users/${username}`;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, moved_to, last_status_at)
       VALUES (?, ?, 'local.example.test', 'pub', 'priv', 1, 1, ?, ?)`
    )
    .bind(id, username, movedTo, new Date().toISOString())
    .run();
  return id;
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
});

describe("moved accounts are hidden from discovery", () => {
  it("keeps a moved account out of the suggestions", async () => {
    const viewer = await seedLocal("viewer");
    await seedLocal("alice");
    await seedLocal("gone", "https://fedisocial.example/users/gone");

    const suggestions = await getAccountSuggestions(db, viewer, { limit: 20 });
    const usernames = suggestions.map((s) => s.actor.username);

    expect(usernames).toContain("alice");
    // Mastodon's `Account.searchable` excludes moved accounts.
    expect(usernames).not.toContain("gone");
  });

  it("keeps a moved account out of the directory", async () => {
    await seedLocal("alice");
    await seedLocal("gone", "https://fedisocial.example/users/gone");

    const res = await DIRECTORY_GET(new NextRequest(`${BASE}/api/v1/directory?local=true&limit=50`));
    expect(res.status).toBe(200);
    const accounts = (await res.json()) as { username: string }[];

    expect(accounts.map((a) => a.username)).toContain("alice");
    expect(accounts.map((a) => a.username)).not.toContain("gone");
  });
});
