import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

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

import { processInboxActivity } from "@/lib/activitypub/inbox";

const db = env.DB;
const BASE = "https://local.example.test";
const LOCAL = `${BASE}/users/manalejandro`;
const GUARDIAN = `${BASE}/users/guardian`;
const REPORTER = "https://remote.example/actor";
const REPORTER2 = "https://remote2.example/actor";
const REMOTE_TARGET = "https://other.example/users/otro";

function flagActivity(id: string, object: string[], actor = REPORTER) {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `https://remote.example/activities/${id}`,
    type: "Flag",
    actor,
    content: "acoso en los comentarios",
    object,
  };
}

async function seedActor(id: string, username: string, domain: string, local: boolean, email: string | null = null) {
  await db
    .prepare(
      "INSERT INTO actors (id, username, domain, public_key_pem, is_local, email, email_verified) VALUES (?,?,?,'k',?,?,1)"
    )
    .bind(id, username, domain, local ? 1 : 0, email)
    .run();
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  await seedActor(LOCAL, "manalejandro", "local.example.test", true, "manalejandro@example.com");
  await seedActor(REPORTER, "actor", "remote.example", false);
  await seedActor(REPORTER2, "actor2", "remote2.example", false);
  await seedActor(REMOTE_TARGET, "otro", "other.example", false);
});

describe("inbound Flag (report) handling", () => {
  it("stores the report and notifies the reported local account from the Guardian", async () => {
    await processInboxActivity(flagActivity("f1", [LOCAL]) as never, {
      db, kv: env.KV, baseUrl: BASE, signingActorId: REPORTER,
    } as never);

    const report = await db
      .prepare("SELECT actor_id, target_id, comment FROM reports")
      .first<{ actor_id: string; target_id: string; comment: string }>();
    expect(report).toMatchObject({ actor_id: REPORTER, target_id: LOCAL, comment: "acoso en los comentarios" });

    const notifs = await db
      .prepare("SELECT type, account_id, target_account_id FROM notifications")
      .all<{ type: string; account_id: string; target_account_id: string }>();
    expect(notifs.results).toEqual([
      { type: "moderation", account_id: GUARDIAN, target_account_id: LOCAL },
    ]);

    // The Guardian is created lazily as a reserved local admin so the
    // notification never exposes the reporter's identity.
    const guardian = await db
      .prepare("SELECT is_local, reserved, role FROM actors WHERE id = ?")
      .bind(GUARDIAN)
      .first<{ is_local: number; reserved: number; role: string }>();
    expect(guardian).toMatchObject({ is_local: 1, reserved: 1, role: "admin" });
  });

  it("does not notify when the reported account is remote", async () => {
    await processInboxActivity(flagActivity("f2", [REMOTE_TARGET]) as never, {
      db, kv: env.KV, baseUrl: BASE, signingActorId: REPORTER,
    } as never);

    const report = await db.prepare("SELECT target_id FROM reports").first<{ target_id: string }>();
    expect(report?.target_id).toBe(REMOTE_TARGET);
    const notifs = await db.prepare("SELECT COUNT(*) AS n FROM notifications").first<{ n: number }>();
    expect(notifs?.n).toBe(0);
  });

  it("deduplicates a replayed Flag and keeps a single notification", async () => {
    await processInboxActivity(flagActivity("f3", [LOCAL]) as never, {
      db, kv: env.KV, baseUrl: BASE, signingActorId: REPORTER,
    } as never);
    await processInboxActivity(flagActivity("f4", [LOCAL]) as never, {
      db, kv: env.KV, baseUrl: BASE, signingActorId: REPORTER,
    } as never);

    const reports = await db.prepare("SELECT COUNT(*) AS n FROM reports").first<{ n: number }>();
    expect(reports?.n).toBe(1);
    const notifs = await db.prepare("SELECT COUNT(*) AS n FROM notifications").first<{ n: number }>();
    expect(notifs?.n).toBe(1);
  });

  it("emails the owner at most once per day even when several reports arrive", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      db, kv: env.KV, baseUrl: BASE,
      email: { send }, fromEmail: "noreply@local.example.test", instanceTitle: "Test Instance",
    };
    await processInboxActivity(flagActivity("f5", [LOCAL], REPORTER) as never, { ...ctx, signingActorId: REPORTER } as never);
    await processInboxActivity(flagActivity("f6", [LOCAL], REPORTER2) as never, { ...ctx, signingActorId: REPORTER2 } as never);

    const reports = await db.prepare("SELECT COUNT(*) AS n FROM reports").first<{ n: number }>();
    expect(reports?.n).toBe(2);
    const notifs = await db.prepare("SELECT COUNT(*) AS n FROM notifications").first<{ n: number }>();
    expect(notifs?.n).toBe(2);

    // One email for both reports: the KV throttle protects the target from
    // being mail-bombed through a report flood.
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][0] as { to: string; subject: string };
    expect(message.to).toBe("manalejandro@example.com");
    expect(message.subject).toContain("Reporte recibido");
  });
});
