import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

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
const AUTHOR = "https://fedisocial.com/users/hcv13";
const NOTE = "https://fedisocial.com/objects/d0fc1cb1";

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestDatabase();
  await db
    .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?,?,?,'k',1)")
    .bind(LOCAL, "manalejandro", "local.example.test")
    .run();
  await db
    .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?,?,?,'k',0)")
    .bind(AUTHOR, "hcv13", "fedisocial.com")
    .run();
});

function createActivity(href: string) {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: "https://fedisocial.com/activities/a1",
    type: "Create",
    actor: AUTHOR,
    published: "2026-10-06T00:44:07Z",
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    cc: [href],
    object: {
      id: NOTE,
      type: "Note",
      attributedTo: AUTHOR,
      content: `<p>Hola <a href="${href}" class="u-url mention">@manalejandro</a></p>`,
      tag: [{ type: "Mention", href, name: "@manalejandro@local.example.test" }],
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      cc: [href],
      published: "2026-10-06T00:44:07Z",
    },
  };
}

describe("mention notification href aliases", () => {
  it("notifies the local account when a peer sends /@user instead of the actor IRI", async () => {
    await processInboxActivity(createActivity(`${BASE}/@manalejandro`) as never, { db, baseUrl: BASE } as never);

    const rows = await db
      .prepare("SELECT type, account_id, target_account_id, object_id FROM notifications")
      .all<{ type: string; account_id: string; target_account_id: string; object_id: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({
      type: "mention",
      account_id: AUTHOR,
      target_account_id: LOCAL,
      object_id: NOTE,
    });
  });

  it("still notifies for the canonical actor IRI", async () => {
    await processInboxActivity(createActivity(LOCAL) as never, { db, baseUrl: BASE } as never);

    const rows = await db.prepare("SELECT type, target_account_id FROM notifications").all<{ type: string; target_account_id: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({ type: "mention", target_account_id: LOCAL });
  });
});
