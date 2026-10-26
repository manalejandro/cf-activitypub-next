import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyTestSchema, resetTestStorage } from "./helpers/db";
import { sweepOrphanUploads, uploadIdFromKey } from "@/lib/media/orphan-uploads";

const db = env.DB;
const BASE = "https://local.example.test";
const ALICE = `${BASE}/users/alice`;

const ORPHAN_KEY = "media/alice/aaaabbbbccccddddeeeeffff00001111.png";
const REFERENCED_KEY = "media/alice/11112222333344445555666677778888.png";
const SCHEDULED_KEY = "media/alice/deadbeefdeadbeefdeadbeefdeadbeef01.png";

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
       VALUES (?, 'alice', 'local.example.test', 'pub', 'priv', 1)`
    )
    .bind(ALICE)
    .run();
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, published, updated_at, is_local)
       VALUES (?, 'Note', ?, '<p>x</p>', 'public', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', 1)`
    )
    .bind(`${BASE}/objects/o1`, ALICE)
    .run();
  // An attachment that references its upload by the served URL.
  await db
    .prepare("INSERT INTO attachments (id, object_id, type, url) VALUES ('a1', ?, 'image', ?)")
    .bind(`${BASE}/objects/o1`, `${BASE}/api/media/${REFERENCED_KEY}`)
    .run();
  // A scheduled post reserving its upload for up to 30 days.
  await db
    .prepare(
      "INSERT INTO scheduled_statuses (id, actor_id, scheduled_at, params, media_ids) VALUES ('s1', ?, datetime('now', '+3 days'), '{}', ?)"
    )
    .bind(ALICE, JSON.stringify([uploadIdFromKey(SCHEDULED_KEY)]))
    .run();

  const bytes = new Uint8Array([1, 2, 3, 4]);
  await env.R2.put(ORPHAN_KEY, bytes);
  await env.R2.put(REFERENCED_KEY, bytes);
  await env.R2.put(SCHEDULED_KEY, bytes);
  await env.R2.put("cache/media/shared.png", bytes);
});

describe("uploadIdFromKey", () => {
  it("extracts the pending-media id from both key shapes", () => {
    expect(uploadIdFromKey("media/alice/aaaabbbbccccddddeeeeffff00001111.png")).toBe("aaaabbbbccccddddeeeeffff00001111");
    expect(uploadIdFromKey("media/alice/9f8a3c1e-2b4d-4e6f-8a90-112233445566-foto.png")).toBe(
      "9f8a3c1e-2b4d-4e6f-8a90-112233445566"
    );
  });
});

describe("sweepOrphanUploads", () => {
  it("deletes the unreferenced upload and keeps referenced, scheduled and cached keys", async () => {
    // minAgeDays 0: miniflare's R2 cannot backdate `uploaded`, so the age
    // rail is exercised by production defaults and the reference rules here.
    const result = await sweepOrphanUploads(
      { DB: db, R2: env.R2 },
      { listBatch: 100, deleteBatch: 10, minAgeDays: 0 }
    );
    expect(result.deleted).toBe(1);

    expect(await env.R2.get(ORPHAN_KEY)).toBeNull();
    expect(await env.R2.get(REFERENCED_KEY)).not.toBeNull();
    expect(await env.R2.get(SCHEDULED_KEY)).not.toBeNull();
    // The shared media cache is never touched by this sweep.
    expect(await env.R2.get("cache/media/shared.png")).not.toBeNull();
  });

  it("is a no-op on a second pass (the orphan is gone)", async () => {
    await sweepOrphanUploads({ DB: db, R2: env.R2 }, { listBatch: 100, deleteBatch: 10, minAgeDays: 0 });
    const second = await sweepOrphanUploads(
      { DB: db, R2: env.R2 },
      { listBatch: 100, deleteBatch: 10, minAgeDays: 0 }
    );
    expect(second.deleted).toBe(0);
  });
});
