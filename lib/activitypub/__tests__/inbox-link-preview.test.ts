// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Database, D1Result } from "@cloudflare/workers-types";

const federation = vi.hoisted(() => ({
  deliverToInbox: vi.fn().mockResolvedValue(undefined),
  signedGetHeaders: vi.fn().mockResolvedValue({}),
  fetchRemoteObject: vi.fn().mockResolvedValue(null),
  safeFetch: vi.fn(),
  validateOutboundUrl: vi.fn(() => ({ valid: true })),
}));

vi.mock("@/lib/activitypub/federation", () => federation);

vi.mock("@/lib/streaming/broadcast", () => ({
  broadcastNotificationEvent: vi.fn().mockResolvedValue(undefined),
  broadcastEvent: vi.fn().mockResolvedValue(undefined),
  broadcastPublicStatus: vi.fn().mockResolvedValue(undefined),
  broadcastHomeStatus: vi.fn().mockResolvedValue(undefined),
  broadcastObjectDelete: vi.fn().mockResolvedValue(undefined),
  broadcastStatusInteraction: vi.fn().mockResolvedValue(undefined),
  broadcastStatusInteractionToLists: vi.fn().mockResolvedValue(undefined),
  broadcastStatusRefresh: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/push", () => ({
  deliverPushSafe: vi.fn().mockResolvedValue(undefined),
}));

import { processInboxActivity } from "@/lib/activitypub/inbox";
import { getObjectById } from "@/lib/db";
import { processLinkPreviewQueue, type LinkPreviewBindings, type LinkPreviewLimits } from "@/lib/link-preview";

/** Minimal D1 adapter backed by node:sqlite (in-memory, schema loaded). */
class D1Adapter {
  private sql = new DatabaseSync(":memory:");

  constructor(schemaSql: string) {
    this.sql.exec("PRAGMA foreign_keys = ON");
    this.sql.exec(schemaSql);
  }

  async batch(statements: { run(): Promise<D1Result> }[]): Promise<D1Result[]> {
    const results: D1Result[] = [];
    for (const s of statements) results.push(await s.run());
    return results;
  }

  prepare(query: string) {
    const stmt = this.sql.prepare(query);
    return {
      bind(...params: unknown[]) {
        const bound = params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p));
        return {
          async all<T = unknown>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }> {
            return { results: stmt.all(...(bound as never[])) as unknown as T[], success: true, meta: {} };
          },
          async first<T = unknown>(): Promise<T | null> {
            return (stmt.get(...(bound as never[])) as unknown as T | undefined) ?? null;
          },
          async run(): Promise<D1Result> {
            const info = stmt.run(...(bound as never[]));
            return { success: true, meta: { changes: info.changes }, results: [] } as unknown as D1Result<unknown>;
          },
        };
      },
    };
  }
}

function okJson(payload: unknown): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    body: undefined,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

function forbidden(): Response {
  return { ok: false, status: 403, headers: new Headers(), body: undefined } as unknown as Response;
}

const BASE = "https://local.example.test";
const ANNOUNCER = "https://newsmast.example/users/socialmedia";
const AUTHOR = "https://mastodon.example/users/bissetwv";
const NOTE_ID = "https://mastodon.example/users/bissetwv/statuses/1";

const LIMITS: LinkPreviewLimits = {
  enabled: true,
  fetchBatch: 5,
  days: 14,
  maxBytes: 2 * 1024 * 1024,
  userAgents: ["bot-agent", "browser-agent"],
  mediaCacheEnabled: false,
};

const OEMBED = {
  version: "1.0",
  type: "video",
  width: 480,
  height: 270,
  title: "Mi vídeo",
  author_name: "Un canal",
  provider_name: "YouTube",
  provider_url: "https://www.youtube.com/",
  thumbnail_url: "https://i.ytimg.com/vi/9-hgsC-JxaI/hqdefault.jpg",
  html:
    '<iframe width="480" height="270" src="https://www.youtube.com/embed/9-hgsC-JxaI?feature=oembed" allowfullscreen></iframe>',
};

function makeAnnounce(overrides: Record<string, unknown> = {}) {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: "https://newsmast.example/activities/announce-1",
    type: "Announce",
    actor: ANNOUNCER,
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    cc: [`${ANNOUNCER}/followers`],
    object: {
      id: NOTE_ID,
      type: "Note",
      attributedTo: AUTHOR,
      content: '<p>Mira <a href="https://youtu.be/9-hgsC-JxaI">esto</a></p>',
      url: "https://mastodon.example/@bissetwv/1",
      published: "2026-09-29T04:55:50Z",
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      cc: [`${AUTHOR}/followers`],
      ...overrides,
    },
  };
}

let db: D1Database;
let bindings: LinkPreviewBindings;

beforeEach(async () => {
  federation.safeFetch.mockReset();
  federation.validateOutboundUrl.mockReturnValue({ valid: true });
  const schema = readFileSync(join(process.cwd(), "lib/db/schema.sql"), "utf8");
  db = new D1Adapter(schema) as unknown as D1Database;
  bindings = { DB: db, KV: undefined };
  await db
    .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?, ?, ?, ?, 0)")
    .bind(ANNOUNCER, "socialmedia", "newsmast.example", "k")
    .run();
  await db
    .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?, ?, ?, ?, 0)")
    .bind(AUTHOR, "bissetwv", "mastodon.example", "k")
    .run();
});

describe("boosted statuses queue their link preview", () => {
  it("enqueues the announced object's first link and crawls it without the watch page", async () => {
    await processInboxActivity(makeAnnounce() as never, { db, baseUrl: BASE } as never);

    const object = await getObjectById(db, NOTE_ID);
    expect(object).not.toBeNull();

    const queued = await db
      .prepare("SELECT object_id FROM link_preview_queue WHERE object_id = ?")
      .bind(NOTE_ID)
      .first<{ object_id: string }>();
    expect(queued?.object_id).toBe(NOTE_ID);

    // YouTube 403s the watch page from datacenter IPs: the video id (oEmbed +
    // thumbnail + player) must still produce the card the boost was missing.
    federation.safeFetch.mockImplementation(async (url: string) =>
      url.includes("/oembed") ? okJson(OEMBED) : forbidden()
    );
    expect(await processLinkPreviewQueue(bindings, LIMITS, "local.example.test")).toBe(1);

    const card = await db
      .prepare("SELECT card_id, card_json FROM objects WHERE id = ?")
      .bind(NOTE_ID)
      .first<{ card_id: string; card_json: string }>();
    expect(card?.card_id).toBeTruthy();
    const snapshot = JSON.parse(card!.card_json) as Record<string, unknown>;
    expect(snapshot.title).toBe("Mi vídeo");
    expect(snapshot.type).toBe("video");
    expect(snapshot.embed_url).toBe("https://www.youtube.com/embed/9-hgsC-JxaI?feature=oembed");
  });

  it("does not queue boosted statuses that carry media (Mastodon behaviour)", async () => {
    await processInboxActivity(
      makeAnnounce({
        attachment: [{ type: "Document", mediaType: "image/png", url: "https://mastodon.example/media/a.png" }],
      }) as never,
      { db, baseUrl: BASE } as never
    );

    const queued = await db
      .prepare("SELECT COUNT(*) AS n FROM link_preview_queue WHERE object_id = ?")
      .bind(NOTE_ID)
      .first<{ n: number }>();
    expect(queued?.n).toBe(0);
  });
});
