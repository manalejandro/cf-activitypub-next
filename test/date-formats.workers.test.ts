import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { env } from "cloudflare:workers";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";
import { createObject, getObjectById, updateObject } from "@/lib/db";
import { GET as GET_HISTORY } from "@/app/api/v1/statuses/[id]/history/route";

const BASE = "https://cf-ap.com";
const ACTOR = `${BASE}/users/ana`;
const NOTE = `${BASE}/objects/11111111-2222-4333-8444-555555555555`;

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestDatabase();
  await env.DB
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable)
       VALUES (?, 'ana', 'cf-ap.com', 'pub', 'priv', 1, 1)`
    )
    .bind(ACTOR)
    .run();
  await createObject(env.DB, {
    id: NOTE,
    type: "Note",
    actorId: ACTOR,
    content: "<p>hola</p>",
    contentWarning: null,
    sensitive: false,
    visibility: "public",
    inReplyToId: null,
    quoteId: null,
    language: null,
    url: NOTE,
    repliesCount: 0,
    reblogsCount: 0,
    favouritesCount: 0,
    published: "2026-10-22T10:00:00.000Z",
    local: true,
    raw: JSON.stringify({ id: NOTE, type: "Note", content: "<p>hola</p>" }),
  });
});

describe("object timestamps", () => {
  it("edits stamp `updated_at` in ISO, like `published` (one shape per column)", async () => {
    await updateObject(env.DB, NOTE, { content: "<p>hola editado</p>" });
    const row = await env.DB
      .prepare("SELECT updated_at, published FROM objects WHERE id = ?")
      .bind(NOTE)
      .first<{ updated_at: string; published: string }>();

    // A `datetime('now')` value here sorted *below* the status it edited: 'T'
    // (ISO) sorts after ' ' at the same date, so timelines and the "edited"
    // badge read the wrong order.
    expect(row?.updated_at).toContain("T");
    expect(row?.updated_at.endsWith("Z")).toBe(true);
    expect(row!.updated_at > row!.published).toBe(true);
    expect(await getObjectById(env.DB, NOTE)).not.toBeNull();
  });
});

describe("status history API", () => {
  it("returns ISO dates for rows stored in the database shape", async () => {
    // The edit row carries `datetime('now')` (its column's shape)…
    await updateObject(env.DB, NOTE, { content: "<p>hola editado</p>" });

    const res = await GET_HISTORY(
      new NextRequest(`${BASE}/api/v1/statuses/${encodeURIComponent(NOTE)}/history`, {
        headers: { Accept: "application/json" },
      }),
      // A directly-invoked handler receives the parameter already decoded.
      { params: Promise.resolve({ id: NOTE }) }
    );
    expect(res.status).toBe(200);
    const history = (await res.json()) as { created_at: string }[];
    expect(history.length).toBeGreaterThan(0);
    // …and the API converts it: a Mastodon client (and our web client) would
    // parse "2026-10-23 19:33:23" as local time.
    for (const entry of history) {
      expect(entry.created_at).toContain("T");
      expect(entry.created_at.endsWith("Z")).toBe(true);
    }
  });
});
