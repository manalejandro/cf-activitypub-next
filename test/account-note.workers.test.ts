import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

import { POST as SAVE_NOTE } from "@/app/api/v1/accounts/[id]/note/route";
import { GET as RELATIONSHIPS } from "@/app/api/v1/accounts/relationships/route";

const db = env.DB;
const BASE = env.INSTANCE_URL ?? "https://local.example.test";
const ME = `${BASE}/users/me`;
const TARGET = "https://remote.example/users/alice";
const TOKEN = "note-token";

async function seed(): Promise<void> {
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, email, email_verified)
       VALUES (?, 'me', ?, 'pub', 'priv', 1, 1, 'me@example.com', 1),
              (?, 'alice', 'remote.example', 'pub', NULL, 0, 1, 'alice@remote.example', 1)`
    )
    .bind(ME, new URL(ME).hostname, TARGET)
    .run();
  await db
    .prepare(
      `INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at)
       VALUES ('t-note', ?, NULL, ?, 'read write', datetime('now'))`
    )
    .bind(ME, TOKEN)
    .run();
}

function saveNote(comment: unknown): Promise<Response> {
  return SAVE_NOTE(
    new NextRequest(`${BASE}/api/v1/accounts/${encodeURIComponent(TARGET)}/note`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ comment }),
    }),
    { params: Promise.resolve({ id: TARGET }) }
  );
}

async function relationshipNote(): Promise<string> {
  const res = await RELATIONSHIPS(
    new NextRequest(`${BASE}/api/v1/accounts/relationships?id[]=${encodeURIComponent(TARGET)}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
  );
  const [rel] = (await res.json()) as { note: string }[];
  return rel.note;
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  await seed();
});

describe("the private note about an account", () => {
  it("saves it, answers with the relationship and reads it back", async () => {
    const res = await saveNote("Ojo con esta cuenta");
    expect(res.status).toBe(200);
    // Mastodon answers this endpoint with the Relationship, which is where the
    // note lives (`Relationship#note`) — the client needs it back.
    const rel = (await res.json()) as { id: string; note: string };
    expect(rel).toMatchObject({ id: TARGET, note: "Ojo con esta cuenta" });
    expect(await relationshipNote()).toBe("Ojo con esta cuenta");
  });

  it("replaces the previous note instead of piling up rows", async () => {
    await saveNote("primera");
    await saveNote("segunda");

    const rows = await db
      .prepare("SELECT comment FROM account_notes WHERE actor_id = ? AND target_id = ?")
      .bind(ME, TARGET)
      .all<{ comment: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].comment).toBe("segunda");
    expect(await relationshipNote()).toBe("segunda");
  });

  it("clears it with an empty comment and caps what it stores", async () => {
    await saveNote("algo");
    await saveNote("");
    expect(await relationshipNote()).toBe("");

    await saveNote("x".repeat(5000));
    const stored = await db
      .prepare("SELECT comment FROM account_notes WHERE actor_id = ? AND target_id = ?")
      .bind(ME, TARGET)
      .first<{ comment: string }>();
    expect(stored?.comment).toHaveLength(2000);
  });

  it("requires a session and an existing target", async () => {
    const anonymous = await SAVE_NOTE(
      new NextRequest(`${BASE}/api/v1/accounts/${encodeURIComponent(TARGET)}/note`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment: "x" }),
      }),
      { params: Promise.resolve({ id: TARGET }) }
    );
    expect(anonymous.status).toBe(401);

    const missing = await SAVE_NOTE(
      new NextRequest(`${BASE}/api/v1/accounts/${encodeURIComponent(`${BASE}/users/nobody`)}/note`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ comment: "x" }),
      }),
      { params: Promise.resolve({ id: `${BASE}/users/nobody` }) }
    );
    expect(missing.status).toBe(404);
  });
});
