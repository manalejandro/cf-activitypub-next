import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

import { GET as STATUS_MD } from "@/app/md/statuses/[id]/route";
import { GET as USER_MD } from "@/app/md/users/[username]/route";

const db = env.DB;
const BASE = env.INSTANCE_URL ?? "https://local.example.test";
const ME = `${BASE}/users/ana`;
const UUID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const STATUS = `${BASE}/objects/${UUID}`;

async function seed(): Promise<void> {
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, display_name, summary, email, email_verified, followers_count, following_count, statuses_count, created_at)
       VALUES (?, 'ana', ?, 'pub', 'priv', 1, 1, 'Ana', '<p>Bio</p>', 'ana@example.com', 1, 7, 3, 2, '2026-01-01T00:00:00Z')`
    )
    .bind(ME, new URL(ME).hostname)
    .run();
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, content_warning, visibility, published, updated_at, is_local, replies_count, reblogs_count, favourites_count)
       VALUES (?, 'Note', ?, '<p>Hola <strong>mundo</strong></p>', 'cw', 'public', '2026-10-20T10:00:00Z', '2026-10-20T10:00:00Z', 1, 1, 2, 3)`
    )
    .bind(STATUS, ME)
    .run();
  await db
    .prepare(
      `INSERT INTO attachments (id, object_id, type, url, description) VALUES ('a1', ?, 'image', 'https://local.example/media/1.jpg', 'una foto')`
    )
    .bind(STATUS)
    .run();
}

function statusRequest(id: string): NextRequest {
  return new NextRequest(`${BASE}/md/statuses/${id}`);
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  await seed();
});

describe("markdown documents over HTTP", () => {
  it("serves the status permalink as markdown", async () => {
    const res = await STATUS_MD(statusRequest(UUID), { params: Promise.resolve({ id: UUID }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(res.headers.get("Vary")).toBe("Accept");
    const body = await res.text();
    expect(body).toContain("# Ana (@ana)");
    expect(body).toContain("> **cw**");
    expect(body).toContain("Hola **mundo**");
    expect(body).toContain("![una foto](https://local.example/media/1.jpg)");
    expect(body).toContain("- Replies: 1 · Boosts: 2 · Favourites: 3");
    expect(body).toContain(`- ActivityPub: ${STATUS}`);
  });

  it("serves a profile with its recent posts", async () => {
    const res = await USER_MD(new NextRequest(`${BASE}/md/users/ana`), {
      params: Promise.resolve({ username: "ana" }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("# Ana (@ana)");
    expect(body).toContain("Bio");
    expect(body).toContain("- Followers: 7 · Following: 3 · Posts: 2");
    expect(body).toContain("## Recent posts");
    expect(body).toContain(`/statuses/${UUID}`);
  });

  it("does not serve markdown for something that is not visible", async () => {
    // A suspended author serves nothing (its permalink is a 404 too).
    await db.prepare("UPDATE actors SET suspended = 1 WHERE id = ?").bind(ME).run();
    const suspendedStatus = await STATUS_MD(statusRequest(UUID), { params: Promise.resolve({ id: UUID }) });
    expect(suspendedStatus.status).toBe(404);
    const suspendedProfile = await USER_MD(new NextRequest(`${BASE}/md/users/ana`), {
      params: Promise.resolve({ username: "ana" }),
    });
    expect(suspendedProfile.status).toBe(404);

    // A followers-only status is served to its audience but never cached publicly.
    await db.prepare("UPDATE actors SET suspended = 0 WHERE id = ?").bind(ME).run();
    await db.prepare("UPDATE objects SET visibility = 'private' WHERE id = ?").bind(STATUS).run();
    const privateStatus = await STATUS_MD(statusRequest(UUID), { params: Promise.resolve({ id: UUID }) });
    expect(privateStatus.status).toBe(404);
  });
});
