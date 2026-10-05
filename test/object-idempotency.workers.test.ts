import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAttachment, createObject, getObjectById, updateObject } from "@/lib/db";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

beforeAll(async () => {
  await applyTestSchema();
});

const ACTOR = "https://remote.example/users/fan";
const OBJ = "https://remote.example/objects/1";

function objectDoc(content: string) {
  return {
    id: OBJ,
    type: "Note",
    actorId: ACTOR,
    content,
    contentWarning: null,
    sensitive: false,
    visibility: "public" as const,
    inReplyToId: null,
    quoteId: null,
    language: "en",
    url: OBJ,
    repliesCount: 0,
    reblogsCount: 0,
    favouritesCount: 0,
    published: "2026-09-17T10:00:00.000Z",
    local: false,
    raw: JSON.stringify({ id: OBJ, type: "Note", content, tag: [{ type: "Hashtag", name: "#test" }] }),
  };
}

const db = env.DB;

beforeEach(async () => {
  await resetTestDatabase();
  await db.prepare(
    `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
     VALUES (?, 'fan', 'remote.example', 'k', NULL, 0)`
  ).bind(ACTOR).run();
});

describe("idempotent remote object ingestion", () => {
  it("maintains the link-post flag on create and edit (Guardian count)", async () => {
    await createObject(db, objectDoc("no links here"));
    const noLink = await db.prepare("SELECT has_link FROM objects WHERE id = ?").bind(OBJ).first<{ has_link: number }>();
    expect(noLink?.has_link).toBe(0);

    // Editing the content recomputes it (the patrol counts via the index).
    await updateObject(db, OBJ, { content: '<p>see https://example.com</p>' });
    const withLink = await db.prepare("SELECT has_link FROM objects WHERE id = ?").bind(OBJ).first<{ has_link: number }>();
    expect(withLink?.has_link).toBe(1);
  });

  it("marks a post whose content contains an uppercase link (LIKE semantics)", async () => {
    const obj = { ...objectDoc("<p>HTTP://EXAMPLE.COM</p>") };
    await createObject(db, obj);
    const row = await db.prepare("SELECT has_link FROM objects WHERE id = ?").bind(OBJ).first<{ has_link: number }>();
    expect(row?.has_link).toBe(1);
  });

  it("returns true on the first insert and false on a concurrent duplicate", async () => {
    expect(await createObject(db, objectDoc("first"))).toBe(true);
    // A second delivery (shared inbox + user inbox, retry…) must not throw.
    expect(await createObject(db, objectDoc("second"))).toBe(false);

    const stored = await getObjectById(db, OBJ);
    expect(stored?.content).toBe("first");
  });

  it("does not duplicate attachments on a replayed delivery", async () => {
    await createObject(db, objectDoc("first"));
    const att = {
      id: "att-1",
      objectId: OBJ,
      type: "image",
      url: "https://remote.example/a.png",
      remoteUrl: "https://remote.example/a.png",
      description: null,
      blurhash: null,
      width: null,
      height: null,
      fileSize: null,
      mimeType: "image/png",
      sensitive: false,
      createdAt: "2026-09-17T10:00:00.000Z",
    };
    await createAttachment(db, att);
    await createAttachment(db, att);

    const rows = await db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE object_id = ?").bind(OBJ).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });
});
