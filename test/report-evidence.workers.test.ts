import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

const broadcastMocks = vi.hoisted(() => ({
  broadcastAccountUpdate: vi.fn(async () => {}),
}));
vi.mock("@/lib/streaming/broadcast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/streaming/broadcast")>()),
  broadcastAccountUpdate: broadcastMocks.broadcastAccountUpdate,
}));

import { GET as REPORTS } from "@/app/api/v1/admin/reports/route";
import { applyRemoteSuspension } from "@/lib/db";
import { processInboxActivity } from "@/lib/activitypub/inbox";
import { encodeStatusId } from "@/lib/mastodon/statusId";

const db = env.DB;
const BASE = env.INSTANCE_URL ?? "https://local.example.test";
const ADMIN = `${BASE}/users/admin`;
const REPORTER = `${BASE}/users/reporter`;
const TARGET = "https://remote.example/users/spammer";
const POST = "https://remote.example/users/spammer/statuses/1";
const TOKEN = "report-token";

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

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  broadcastMocks.broadcastAccountUpdate.mockClear();
  await seedActor(ADMIN, { role: "admin" });
  await seedActor(REPORTER);
  await seedActor(TARGET, { local: false });
  await db
    .prepare(
      "INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES ('t1', ?, NULL, ?, 'read write', datetime('now'))"
    )
    .bind(ADMIN, TOKEN)
    .run();
});

describe("report evidence", () => {
  it("shows the text and media of a post whose content was nulled by moderation", async () => {
    // A suspension nulls the posts' content ("stop spreading"), the AP document
    // keeps the text — the admin must still see what was reported.
    await db
      .prepare(
        `INSERT INTO objects (id, type, actor_id, content, visibility, published, updated_at, is_local, raw)
         VALUES (?, 'Note', ?, NULL, 'public', '2026-10-18T03:00:00Z', '2026-10-18T03:00:00Z', 0, ?)`
      )
      .bind(
        POST,
        TARGET,
        JSON.stringify({
          id: POST,
          type: "Note",
          content: "<p>compra seguidores :spam:</p>",
          tag: [{ type: "Emoji", name: ":spam:", icon: { url: "https://remote.example/emoji/spam.png" } }],
        })
      )
      .run();
    await db
      .prepare(
        `INSERT INTO attachments (id, object_id, type, url, remote_url, description, created_at)
         VALUES ('a1', ?, 'image', 'https://remote.example/media/proof.png', 'https://remote.example/media/proof.png', 'la prueba', datetime('now'))`
      )
      .bind(POST)
      .run();
    await db
      .prepare(
        `INSERT INTO reports (id, actor_id, target_id, status_ids, comment, category, forwarded, created_at)
         VALUES ('r1', ?, ?, ?, 'spam', 'spam', 1, datetime('now'))`
      )
      .bind(REPORTER, TARGET, JSON.stringify([encodeStatusId(POST, false)]))
      .run();

    const res = await REPORTS(
      new NextRequest(`${BASE}/api/v1/admin/reports`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      reports: { forwarded: boolean; statuses: { content: string; media: { url: string }[]; unavailable?: boolean }[] }[];
    };
    const report = data.reports[0];
    expect(report.forwarded).toBe(true);
    expect(report.statuses).toHaveLength(1);
    expect(report.statuses[0].content).toContain("compra seguidores");
    // The custom emoji is re-rendered from the document's Emoji tag.
    expect(report.statuses[0].content).toContain("emoji/spam.png");
    expect(report.statuses[0].media).toEqual([{ url: "https://remote.example/media/proof.png", type: "image", description: "la prueba" }]);
  });

  it("keeps a placeholder for a post that no longer exists", async () => {
    await db
      .prepare(
        `INSERT INTO reports (id, actor_id, target_id, status_ids, comment, category, forwarded, created_at)
         VALUES ('r2', ?, ?, ?, '', 'other', 1, datetime('now'))`
      )
      .bind(REPORTER, TARGET, JSON.stringify([encodeStatusId("https://remote.example/users/spammer/statuses/gone", false)]))
      .run();

    const res = await REPORTS(
      new NextRequest(`${BASE}/api/v1/admin/reports`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    );
    const data = (await res.json()) as { reports: { statuses: { unavailable?: boolean }[] }[] };
    expect(data.reports[0].statuses).toEqual([
      expect.objectContaining({ unavailable: true }),
    ]);
  });
});

describe("the account's own server decides", () => {
  it("stores a remote suspension and tells the clients", async () => {
    await processInboxActivity(
      {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/activities/update-1",
        type: "Update",
        actor: TARGET,
        object: {
          id: TARGET,
          type: "Person",
          preferredUsername: "spammer",
          suspended: true,
        },
      } as never,
      { db, baseUrl: BASE, timelineStream: {} } as never
    );

    const row = await db
      .prepare("SELECT suspended, suspension_origin FROM actors WHERE id = ?")
      .bind(TARGET)
      .first<{ suspended: number; suspension_origin: string | null }>();
    expect(row).toMatchObject({ suspended: 1, suspension_origin: "remote" });
    expect(broadcastMocks.broadcastAccountUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ actorId: TARGET, suspended: true, local: false })
    );
  });

  it("never lets a fetch lift a suspension we applied", async () => {
    // Our own moderation decision, then the account's document says otherwise.
    await db
      .prepare("UPDATE actors SET suspended = 1, suspension_origin = 'local', suspended_at = datetime('now') WHERE id = ?")
      .bind(TARGET)
      .run();

    expect(await applyRemoteSuspension(db, TARGET, false)).toBe(false);
    const row = await db
      .prepare("SELECT suspended, suspension_origin FROM actors WHERE id = ?")
      .bind(TARGET)
      .first<{ suspended: number; suspension_origin: string | null }>();
    expect(row).toMatchObject({ suspended: 1, suspension_origin: "local" });
  });

  it("clears a remote suspension when the origin lifts it", async () => {
    expect(await applyRemoteSuspension(db, TARGET, true)).toBe(true);
    expect(await applyRemoteSuspension(db, TARGET, false)).toBe(true);
    const row = await db
      .prepare("SELECT suspended, suspension_origin, suspended_at FROM actors WHERE id = ?")
      .bind(TARGET)
      .first<{ suspended: number; suspension_origin: string | null; suspended_at: string | null }>();
    expect(row).toMatchObject({ suspended: 0, suspension_origin: null, suspended_at: null });
  });
});
