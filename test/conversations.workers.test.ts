import { beforeAll, describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

beforeAll(async () => {
  await applyTestSchema();
});
import { deleteObject, deleteRemoteActorData } from "@/lib/db";

const OWNER = "https://local.example/users/me";
const REMOTE = "https://remote.example/users/alice";
const CONVERSATION = `dm:${OWNER}::${REMOTE}`;
const MSG_OLDER = "https://remote.example/users/alice/statuses/1";
const MSG_NEWER = "https://remote.example/users/alice/statuses/2";

function directRaw(): string {
  return JSON.stringify({
    to: [OWNER, REMOTE],
    cc: [],
    tag: [
      { type: "Mention", href: OWNER },
      { type: "Mention", href: REMOTE },
    ],
  });
}

const db = env.DB;

beforeEach(async () => {
  await resetTestDatabase();
  await db
    .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?,?,?,?,1)")
    .bind(OWNER, "me", "local.example", "k")
    .run();
  await db
    .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?,?,?,?,0)")
    .bind(REMOTE, "alice", "remote.example", "k")
    .run();
  for (const [id, published] of [[MSG_OLDER, "2026-09-20T10:00:00.000Z"], [MSG_NEWER, "2026-09-21T10:00:00.000Z"]] as const) {
    await db
      .prepare("INSERT INTO objects (id, type, actor_id, visibility, published, updated_at, raw) VALUES (?,?,?,?,?,?,?)")
      .bind(id, "Note", REMOTE, "direct", published, published, directRaw())
      .run();
  }
  await db
    .prepare("INSERT INTO conversations (id, actor_id, last_status_id, unread) VALUES (?,?,?,0)")
    .bind(CONVERSATION, OWNER, MSG_NEWER)
    .run();
});

describe("private-message conversations", () => {
  it("falls back to the previous message when the latest one is deleted", async () => {
    await deleteObject(db, MSG_NEWER);
    const conv = await db
      .prepare("SELECT last_status_id FROM conversations WHERE id = ?")
      .bind(CONVERSATION)
      .first<{ last_status_id: string | null }>();
    expect(conv?.last_status_id).toBe(MSG_OLDER);
  });

  it("drops the conversation when the thread has no messages left", async () => {
    await deleteObject(db, MSG_NEWER);
    await deleteObject(db, MSG_OLDER);
    const conv = await db
      .prepare("SELECT id FROM conversations WHERE id = ?")
      .bind(CONVERSATION)
      .first<{ id: string }>();
    expect(conv).toBeNull();
  });

  it("drops the conversation when its author's account data is purged", async () => {
    await deleteRemoteActorData(db, REMOTE);
    const conv = await db
      .prepare("SELECT id FROM conversations WHERE id = ?")
      .bind(CONVERSATION)
      .first<{ id: string }>();
    expect(conv).toBeNull();
  });
});
