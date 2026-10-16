import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

vi.mock("@/lib/moderation/pipeline", () => ({
  screenStatus: vi.fn().mockResolvedValue({ blocked: false, markedSensitive: false }),
}));
vi.mock("@/lib/streaming/broadcast", () => ({
  broadcastHomeStatus: vi.fn().mockResolvedValue(undefined),
  broadcastPublicStatus: vi.fn().mockResolvedValue(undefined),
  broadcastStatusInteraction: vi.fn().mockResolvedValue(undefined),
  broadcastStatusInteractionToLists: vi.fn().mockResolvedValue(undefined),
  broadcastStatusCreatedToAudience: vi.fn().mockResolvedValue(undefined),
  broadcastNotificationEvent: vi.fn().mockResolvedValue(undefined),
  broadcastEvent: vi.fn().mockResolvedValue(undefined),
  broadcastStatusUpdate: vi.fn().mockResolvedValue(undefined),
  broadcastHomeStatusUpdate: vi.fn().mockResolvedValue(undefined),
  broadcastObjectDelete: vi.fn().mockResolvedValue(undefined),
  eligibleLocalRecipients: vi.fn(async (_db: unknown, ids: string[]) => ids),
  actorExclusion: vi.fn(async (_db: unknown, id: string) => ({ id, domain: null })),
  parentExclusion: vi.fn(async () => null),
}));
vi.mock("@/lib/push", () => ({ deliverPushSafe: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/activitypub/queue", () => ({
  enqueueDeliveries: vi.fn().mockResolvedValue(undefined),
  deliverToInbox: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/activitypub/federation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/activitypub/federation")>()),
  collectFollowerInboxes: vi.fn().mockResolvedValue([]),
}));

import { POST } from "@/app/api/v1/statuses/route";
import { PUT } from "@/app/api/v1/statuses/[id]/route";

const db = env.DB;
const BASE = "https://local.example.test";
const TOKEN = "event-token";
const ACTOR = `${BASE}/users/me`;

const START = "2026-11-20T19:00:00.000Z";
const END = "2026-11-20T21:30:00.000Z";

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new NextRequest("https://local.example.test/api/v1/statuses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    })
  );
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, email, email_verified, discoverable)
       VALUES (?, 'me', 'local.example.test', 'pub', 'priv', 1, 'me@example.com', 1, 1)`
    )
    .bind(ACTOR)
    .run();
  await db
    .prepare(
      "INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES ('t1', ?, NULL, ?, 'read write', datetime('now'))"
    )
    .bind(ACTOR, TOKEN)
    .run();
});

describe("composer event mode", () => {
  it("publishes the status as an ActivityPub Event", async () => {
    const res = await post({
      status: "Concierto en el parque",
      event: { name: "Festival de otoño", start_time: START, end_time: END, location: "Parque Central" },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.ap_type).toBe("Event");
    const meta = data.ap_meta as Record<string, unknown>;
    expect(meta.name).toBe("Festival de otoño");
    expect(meta.startTime).toBe(START);
    expect(meta.endTime).toBe(END);
    expect(meta.location).toBe("Parque Central");

    const row = await db
      .prepare("SELECT type, raw FROM objects WHERE actor_id = ?")
      .bind(ACTOR)
      .first<{ type: string; raw: string }>();
    expect(row?.type).toBe("Event");
    const raw = JSON.parse(row!.raw) as Record<string, unknown>;
    expect(raw.type).toBe("Event");
    expect(raw.name).toBe("Festival de otoño");
    expect(raw.startTime).toBe(START);
    expect(raw.endTime).toBe(END);
    // The venue and the status' geolocation share the `location` property.
    expect(raw.location).toMatchObject({ type: "Place", name: "Parque Central" });
    // The status text stays the description.
    expect(String(raw.content)).toContain("Concierto en el parque");
  });

  it("accepts an event without a description or an end", async () => {
    const res = await post({ event: { name: "Asamblea", start_time: START } });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.ap_type).toBe("Event");
    const raw = JSON.parse(
      (await db.prepare("SELECT raw FROM objects WHERE actor_id = ?").bind(ACTOR).first<{ raw: string }>())!.raw
    ) as Record<string, unknown>;
    expect(raw.endTime).toBeUndefined();
    expect(raw.location).toBeUndefined();
  });

  it("rejects a malformed event with a translatable error code", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ event: { start_time: START } }, "compose_error_event_title"],
      [{ event: { name: "Sin fecha" } }, "compose_error_event_start"],
      [{ event: { name: "Fecha rota", start_time: "mañana" } }, "compose_error_event_start"],
      [{ event: { name: "Fin antes", start_time: START, end_time: "2026-11-20T18:00:00.000Z" } }, "compose_error_event_end"],
      [{ event: "Festival" }, "compose_error_event"],
    ];
    for (const [body, errorCode] of cases) {
      const res = await post({ status: "hola", ...body });
      expect(res.status, errorCode).toBe(422);
      const data = (await res.json()) as Record<string, unknown>;
      expect(data.error_code, errorCode).toBe(errorCode);
    }
    expect(await db.prepare("SELECT COUNT(*) AS n FROM objects").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("ignores a poll sent alongside an event", async () => {
    const res = await post({
      event: { name: "Charla", start_time: START },
      poll: { options: ["Sí", "No"], expires_in: 3600 },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.ap_type).toBe("Event");
    expect(data.poll ?? null).toBeNull();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM polls").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("keeps the geolocation and the venue in one Place", async () => {
    const res = await post({
      status: "Con mapa",
      location: { latitude: 40.4168, longitude: -3.7038 },
      event: { name: "Quedada", start_time: START, location: "Puerta del Sol" },
    });
    expect(res.status).toBe(200);
    const raw = JSON.parse(
      (await db.prepare("SELECT raw FROM objects WHERE actor_id = ?").bind(ACTOR).first<{ raw: string }>())!.raw
    ) as Record<string, unknown>;
    expect(raw.location).toMatchObject({
      type: "Place",
      name: "Puerta del Sol",
      latitude: 40.4168,
      longitude: -3.7038,
    });
  });

  it("keeps the Event shape when the description is edited", async () => {
    const created = await post({
      status: "Primera versión",
      event: { name: "Cine de verano", start_time: START, end_time: END, location: "Azotea" },
    });
    expect(created.status).toBe(200);
    const statusId = ((await created.json()) as { id: string }).id;
    const objectId = (await db
      .prepare("SELECT id FROM objects WHERE actor_id = ?")
      .bind(ACTOR)
      .first<{ id: string }>())!.id;

    const res = await PUT(
      new NextRequest(`https://local.example.test/api/v1/statuses/${statusId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ status: "Segunda versión" }),
      }),
      { params: Promise.resolve({ id: statusId }) }
    );
    expect(res.status).toBe(200);

    const row = await db
      .prepare("SELECT raw FROM objects WHERE id = ?")
      .bind(objectId)
      .first<{ raw: string }>();
    const raw = JSON.parse(row!.raw) as Record<string, unknown>;
    expect(raw.type).toBe("Event");
    expect(raw.name).toBe("Cine de verano");
    expect(raw.startTime).toBe(START);
    expect(raw.endTime).toBe(END);
    expect(String(raw.content)).toContain("Segunda versión");
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.ap_type).toBe("Event");
  });
});
