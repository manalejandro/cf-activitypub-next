import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";
import { GET as PUBLIC_TIMELINE } from "@/app/api/v1/timelines/public/route";
import { GET as INSTANCE } from "@/app/api/v1/instance/route";
import { GET as SETTINGS_GET, PUT as SETTINGS_PUT } from "@/app/api/v1/admin/instance_settings/route";
import { setInstanceSetting } from "@/lib/db";

const db = env.DB;
const BASE = "https://local.example.test";
const TOKEN = "timeline-token";
const ADMIN = `${BASE}/users/admin`;

async function seedActor(id: string, opts: { local?: boolean; role?: string } = {}): Promise<void> {
  const username = id.split("/").pop()!;
  const domain = new URL(id).hostname;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, role, email, email_verified)
       VALUES (?, ?, ?, 'pub', ?, ?, 1, ?, ?, 1)`
    )
    .bind(id, username, domain, opts.local === false ? null : "priv", opts.local === false ? 0 : 1, opts.role ?? "user", `${username}@example.com`)
    .run();
}

async function seedToken(actorId: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES ('t1', ?, NULL, ?, 'read write', datetime('now'))"
    )
    .bind(actorId, TOKEN)
    .run();
}

async function seedStatus(id: string, actorId: string, isLocal: boolean): Promise<void> {
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, published, updated_at, is_local)
       VALUES (?, 'Note', ?, '<p>hello</p>', 'public', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', ?)`
    )
    .bind(id, actorId, isLocal ? 1 : 0)
    .run();
}

function timeline(query = "", token?: string): Promise<Response> {
  return PUBLIC_TIMELINE(
    new NextRequest(`${BASE}/api/v1/timelines/public${query}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
  );
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  await seedActor(ADMIN, { role: "admin" });
  await seedToken(ADMIN);
  await seedActor(`${BASE}/users/alice`);
  await seedActor("https://remote.example/users/bob", { local: false });
  await seedStatus(`${BASE}/objects/1`, `${BASE}/users/alice`, true);
  await seedStatus("https://remote.example/objects/2", "https://remote.example/users/bob", false);
});

describe("anonymous timeline access", () => {
  it("serves the public timeline but not the local one by default", async () => {
    const federated = await timeline();
    expect(federated.status).toBe(200);
    expect(((await federated.json()) as unknown[]).length).toBe(2);

    const local = await timeline("?local=true");
    expect(local.status).toBe(401);
  });

  it("adds the local timeline with the public_local setting", async () => {
    await setInstanceSetting(db, "anonymous_timelines", "public_local");

    const local = await timeline("?local=true");
    expect(local.status).toBe(200);
    expect(((await local.json()) as unknown[]).length).toBe(1);
  });

  it("closes both to anonymous visitors with the none setting", async () => {
    await setInstanceSetting(db, "anonymous_timelines", "none");

    expect((await timeline()).status).toBe(401);
    expect((await timeline("?local=true")).status).toBe(401);
    // A signed-in client is unaffected.
    const mine = await timeline("", TOKEN);
    expect(mine.status).toBe(200);
  });

  it("publishes the setting for the UI and saves it from the admin API", async () => {
    const initial = (await (await INSTANCE(new NextRequest(`${BASE}/api/v1/instance`))).json()) as { anonymous_timelines?: string };
    expect(initial.anonymous_timelines).toBe("public");

    const saved = await SETTINGS_PUT(
      new NextRequest(`${BASE}/api/v1/admin/instance_settings`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ anonymous_timelines: "public_local" }),
      })
    );
    expect(saved.status).toBe(200);

    const settings = await SETTINGS_GET(
      new NextRequest(`${BASE}/api/v1/admin/instance_settings`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    );
    expect(((await settings.json()) as { anonymous_timelines?: string }).anonymous_timelines).toBe("public_local");

    // A typo can never widen access: anything unknown falls back to `public`.
    await setInstanceSetting(db, "anonymous_timelines", "bogus");
    const after = (await (await INSTANCE(new NextRequest(`${BASE}/api/v1/instance`))).json()) as { anonymous_timelines?: string };
    expect(after.anonymous_timelines).toBe("public");
  });
});
