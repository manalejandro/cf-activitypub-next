import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

beforeAll(async () => {
  await applyTestSchema();
});
import { processInboxActivity } from "@/lib/activitypub/inbox";
import {
  getMlsMessagesByRecipient,
  getMlsKeyPackagesByActor,
} from "@/lib/db";

vi.mock("@/lib/streaming/broadcast", () => ({
  broadcastNotificationEvent: vi.fn().mockResolvedValue(undefined),
  broadcastEvent: vi.fn().mockResolvedValue(undefined),
  broadcastPublicStatus: vi.fn().mockResolvedValue(undefined),
  broadcastHomeStatus: vi.fn().mockResolvedValue(undefined),
  eligibleLocalRecipients: vi.fn(async (_db: unknown, ids: string[]) => ids),
  actorExclusion: vi.fn(async (_db: unknown, id: string) => ({ id, domain: null })),
  parentExclusion: vi.fn(async () => null),
}));

vi.mock("@/lib/push", () => ({
  deliverPushSafe: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/activitypub/federation", () => ({
  deliverToInbox: vi.fn().mockResolvedValue(undefined),
  signedGetHeaders: vi.fn().mockResolvedValue({}),
  fetchRemoteObject: vi.fn().mockResolvedValue(null),
}));

const db = env.DB;
const BASE = "https://local.example.test";
const REMOTE_ACTOR = "https://remote.example/users/alice";
const LOCAL_ACTOR = `${BASE}/users/bob`;

async function freshDb(): Promise<void> {
  await resetTestDatabase();
  const insertActor = db.prepare(
    "INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?, ?, ?, ?, ?)"
  );
  await insertActor.bind(REMOTE_ACTOR, "alice", "remote.example", "key-alice", 0).run();
  await insertActor.bind(LOCAL_ACTOR, "bob", "local.example.test", "key-bob", 1).run();
}

function makeKeyPackageCreateActivity() {
  return {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      "https://purl.archive.org/socialweb/mls",
    ],
    id: `${BASE}/activities/kp-create`,
    type: "Create",
    actor: REMOTE_ACTOR,
    published: "2026-01-01T00:00:00Z",
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    object: {
      id: `${REMOTE_ACTOR}/keypackages/1`,
      type: "KeyPackage",
      ciphersuite: "MLS_128_HPKEX25519_AES128GCM_SHA256",
      mediaType: "application/mls+json",
      encoding: "base64",
      content: "cGxhY2Vob2xkZXItZW52ZWxvcGU=",
    },
  };
}

function makePrivateMessageActivity() {
  return {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      "https://purl.archive.org/socialweb/mls",
    ],
    id: `${REMOTE_ACTOR}/activities/msg-1`,
    type: "Create",
    actor: REMOTE_ACTOR,
    published: "2026-01-01T00:00:00Z",
    to: [LOCAL_ACTOR],
    object: {
      id: `${REMOTE_ACTOR}/objects/msg-1`,
      type: "PrivateMessage",
      conversation: `${BASE}/conversations/test`,
      mediaType: "application/mls+json",
      content: "ZW5jcnlwdGVkLWVudmVsb3BlLWJpbmFyeQ==",
    },
  };
}

beforeAll(async () => {
  await freshDb();
});

beforeEach(async () => {
  await freshDb();
});

describe("MLS over ActivityPub inbox handling", () => {
  it("caches a remote Create(KeyPackage) without rendering it as a status", async () => {
    await processInboxActivity(makeKeyPackageCreateActivity() as never, { db, baseUrl: BASE } as never);

    const kps = await getMlsKeyPackagesByActor(db, REMOTE_ACTOR);
    expect(kps).toHaveLength(1);
    expect(kps[0].objectId).toBe(`${REMOTE_ACTOR}/keypackages/1`);
    expect(kps[0].isActive).toBe(true);
    expect(kps[0].ciphersuite).toBe("MLS_128_HPKEX25519_AES128GCM_SHA256");
  });

  it("routes a Create(PrivateMessage) to the explicit local recipient only", async () => {
    await processInboxActivity(makePrivateMessageActivity() as never, { db, baseUrl: BASE } as never);

    const msgs = await getMlsMessagesByRecipient(db, LOCAL_ACTOR, 50);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].objectType).toBe("PrivateMessage");
    expect(msgs[0].actorId).toBe(REMOTE_ACTOR);
    expect(msgs[0].content).toBe("ZW5jcnlwdGVkLWVudmVsb3BlLWJpbmFyeQ==");

    // The sender is remote, so nothing lands in the local user's statuses
    // (this is a ciphertext envelope, not a post).
    const rows = await db.prepare("SELECT id FROM objects LIMIT 1").first<{ id: string }>();
    expect(rows).toBeNull();
  });

  it("drops an Envelope activity addressed to a collection/public", async () => {
    const activity = makePrivateMessageActivity();
    activity.to = ["https://www.w3.org/ns/activitystreams#Public"];
    await processInboxActivity(activity as never, { db, baseUrl: BASE } as never);

    const msgs = await getMlsMessagesByRecipient(db, LOCAL_ACTOR, 50);
    expect(msgs).toHaveLength(0);
  });

  it("surfaces a Create(PublicMessage) on the public timeline as an encrypted envelope", async () => {
    const activity = {
      "@context": [
        "https://www.w3.org/ns/activitystreams",
        "https://purl.archive.org/socialweb/mls",
      ],
      id: `${REMOTE_ACTOR}/activities/pub-1`,
      type: "Create",
      actor: REMOTE_ACTOR,
      published: "2026-01-01T00:00:00Z",
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      object: {
        id: `${REMOTE_ACTOR}/objects/pub-1`,
        type: "PublicMessage",
        conversation: `${BASE}/conversations/test`,
        mediaType: "application/mls+json",
        encoding: "base64",
        content: "ZW5jcnlwdGVkLXB1YmxpYy1tZXNzYWdl",
      },
    };
    await processInboxActivity(activity as never, { db, baseUrl: BASE } as never);

    const obj = await db
      .prepare("SELECT id, type, visibility, content, is_local FROM objects WHERE id = ?")
      .bind(`${REMOTE_ACTOR}/objects/pub-1`)
      .first<{ id: string; type: string; visibility: string; content: string; is_local: number }>();
    expect(obj).toBeDefined();
    expect(obj!.type).toBe("PublicMessage");
    expect(obj!.visibility).toBe("public");
    expect(obj!.is_local).toBe(0);
    expect(obj!.content).toContain("MLS/PublicMessage");
    expect(obj!.content).toContain("ZW5jcnlwdGVkLXB1YmxpYy1tZXNzYWdl");

    // private envelopes still never become statuses
    const rows = await db.prepare("SELECT id FROM objects WHERE type = 'PrivateMessage' LIMIT 1").first<{ id: string }>();
    expect(rows).toBeNull();
  });

  it("toggles key package active state via Add/Remove and cleans up on Delete", async () => {
    await processInboxActivity(makeKeyPackageCreateActivity() as never, { db, baseUrl: BASE } as never);
    expect((await getMlsKeyPackagesByActor(db, REMOTE_ACTOR, false))[0].isActive).toBe(true);

    await processInboxActivity(
      {
        id: `${REMOTE_ACTOR}/activities/kp-remove`,
        type: "Remove",
        actor: REMOTE_ACTOR,
        object: `${REMOTE_ACTOR}/keypackages/1`,
      } as never,
      { db, baseUrl: BASE } as never
    );
    const afterRemove = await getMlsKeyPackagesByActor(db, REMOTE_ACTOR, false);
    expect(afterRemove).toHaveLength(1);
    expect(afterRemove[0].isActive).toBe(false);

    await processInboxActivity(
      {
        id: `${REMOTE_ACTOR}/activities/kp-add`,
        type: "Add",
        actor: REMOTE_ACTOR,
        object: `${REMOTE_ACTOR}/keypackages/1`,
      } as never,
      { db, baseUrl: BASE } as never
    );
    expect((await getMlsKeyPackagesByActor(db, REMOTE_ACTOR))[0].isActive).toBe(true);

    await processInboxActivity(
      {
        id: `${REMOTE_ACTOR}/activities/kp-del`,
        type: "Delete",
        actor: REMOTE_ACTOR,
        object: { id: `${REMOTE_ACTOR}/keypackages/1`, type: "KeyPackage" },
      } as never,
      { db, baseUrl: BASE } as never
    );
    expect((await getMlsKeyPackagesByActor(db, REMOTE_ACTOR))).toHaveLength(0);
  });

  it("does not allow a different actor to Deactivate someone else's key package", async () => {
    await processInboxActivity(makeKeyPackageCreateActivity() as never, { db, baseUrl: BASE } as never);

    const attacker = `${BASE}/users/attacker`;
    await db
      .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?, ?, ?, ?, 1)")
      .bind(attacker, "attacker", "local.example.test", "test-key").run();

    await processInboxActivity(
      {
        id: `${attacker}/activities/keyring-remove`,
        type: "Remove",
        actor: attacker,
        object: `${REMOTE_ACTOR}/keypackages/1`,
      } as never,
      { db, baseUrl: BASE } as never
    );
    expect((await getMlsKeyPackagesByActor(db, REMOTE_ACTOR))[0].isActive).toBe(true);
  });
});