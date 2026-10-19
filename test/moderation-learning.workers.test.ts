import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

// The Guardian's vector memory has no local simulator: the lesson itself is
// covered by `lib/__tests__/learn.test.ts`; here only the wiring matters.
interface LessonCall {
  actorId: string;
  reason?: string | null;
  confidence?: string | null;
  model?: string | null;
  content?: string | null;
}

const learnMocks = vi.hoisted(() => ({
  learnFromSuspension: vi.fn(async (env: unknown, lesson: LessonCall) => (env && lesson.actorId ? { id: `account:${lesson.actorId}`, chars: 42 } : null)),
  forgetSuspension: vi.fn(async (env: unknown, actorId: string) => Boolean(env) && actorId.length > 0),
}));
vi.mock("@/lib/moderation/learn", () => learnMocks);
vi.mock("@/lib/streaming/broadcast", () => ({
  broadcastEvent: vi.fn().mockResolvedValue(undefined),
  broadcastAccountUpdate: vi.fn().mockResolvedValue(undefined),
  broadcastActorUpdate: vi.fn().mockResolvedValue(undefined),
}));

import { POST as SUSPEND } from "@/app/api/v1/admin/accounts/[id]/suspend/route";
import { POST as UNSUSPEND } from "@/app/api/v1/admin/accounts/[id]/unsuspend/route";
import { suspendAccount, unsuspendAccount } from "@/lib/moderation/actions";
import { sweepAbusiveRegistrations } from "@/lib/moderation/registration-sweep";

const db = env.DB;
const BASE = "https://local.example.test";

async function seedActor(
  id: string,
  opts: { role?: string; email?: string; emailVerified?: boolean } = {}
): Promise<string> {
  const username = id.split("/").pop()!;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, role, email, email_verified)
       VALUES (?, ?, 'local.example.test', 'pub', 'priv', 1, 1, ?, ?, ?)`
    )
    .bind(id, username, opts.role ?? "user", opts.email ?? `${username}@example.com`, opts.emailVerified === false ? 0 : 1)
    .run();
  return id;
}

async function seedToken(actorId: string, token: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES (?, ?, NULL, ?, 'read write', datetime('now'))"
    )
    .bind(`t-${token}`, actorId, token)
    .run();
}

async function seedStatus(actorId: string, content: string, published: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, published, updated_at, is_local)
       VALUES (?, 'Note', ?, ?, 'public', ?, ?, 1)`
    )
    .bind(`${actorId}/objects/${Math.random().toString(36).slice(2)}`, actorId, content, published, published)
    .run();
}

function call(
  handler: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>,
  action: "suspend" | "unsuspend",
  id: string,
  token: string
): Promise<Response> {
  return handler(
    new NextRequest(`${BASE}/api/v1/admin/accounts/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }),
    { params: Promise.resolve({ id }) }
  );
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  learnMocks.learnFromSuspension.mockClear();
  learnMocks.forgetSuspension.mockClear();
  await seedActor(`${BASE}/users/admin`, { role: "admin" });
  await seedToken(`${BASE}/users/admin`, "admin-token");
});

describe("the Guardian learns from every suspension", () => {
  it("learns when a moderator suspends from the admin table", async () => {
    await seedActor(`${BASE}/users/spammer`);
    await seedStatus(`${BASE}/users/spammer`, "<p>compra seguidores baratos</p>", "2026-10-15T10:00:00Z");

    const res = await call(SUSPEND, "suspend", `${BASE}/users/spammer`, "admin-token");
    expect(res.status).toBe(200);

    expect(learnMocks.learnFromSuspension).toHaveBeenCalledTimes(1);
    expect(learnMocks.learnFromSuspension.mock.calls[0][1]).toMatchObject({
      actorId: `${BASE}/users/spammer`,
      reason: "Account suspended by an administrator.",
      model: "admin",
    });
    // The audit entry records whether the suspension taught anything.
    const log = await db
      .prepare("SELECT details FROM moderation_log WHERE target_id = ? AND action = 'suspended'")
      .bind(`${BASE}/users/spammer`)
      .first<{ details: string }>();
    expect(JSON.parse(log!.details)).toMatchObject({ learned: { id: `account:${BASE}/users/spammer`, chars: 42 } });
  });

  it("learns from the Guardian's own suspensions, with the offending content", async () => {
    await seedActor(`${BASE}/users/spammer`);

    await suspendAccount(env, {
      actorId: `${BASE}/users/spammer`,
      reason: "spam repetido",
      confidence: "high",
      source: "heuristic",
      model: "heuristic",
      details: { stage: "duplicate_spam", content: "compra ya" },
    });

    expect(learnMocks.learnFromSuspension).toHaveBeenCalledTimes(1);
    expect(learnMocks.learnFromSuspension.mock.calls[0][1]).toMatchObject({
      actorId: `${BASE}/users/spammer`,
      content: "compra ya",
      confidence: "high",
    });
  });

  it("learns a few profiles per registration-sweep wave", async () => {
    for (let i = 0; i < 6; i++) {
      await seedActor(`${BASE}/users/bot${i}`, { email: `bot${i}@mailinator.com`, emailVerified: false });
    }

    const result = await sweepAbusiveRegistrations(env);
    expect(result.suspended).toBeGreaterThanOrEqual(6);
    // Capped: the wave repeats one pattern and must not flood the memory.
    expect(learnMocks.learnFromSuspension).toHaveBeenCalledTimes(5);
  });

  it("forgets the lesson when the suspension is lifted", async () => {
    await seedActor(`${BASE}/users/spammer`);
    await call(SUSPEND, "suspend", `${BASE}/users/spammer`, "admin-token");

    const res = await call(UNSUSPEND, "unsuspend", `${BASE}/users/spammer`, "admin-token");
    expect(res.status).toBe(200);
    expect(learnMocks.forgetSuspension).toHaveBeenCalledWith(expect.anything(), `${BASE}/users/spammer`);

    const log = await db
      .prepare("SELECT details FROM moderation_log WHERE target_id = ? AND action = 'unsuspended'")
      .bind(`${BASE}/users/spammer`)
      .first<{ details: string }>();
    expect(JSON.parse(log!.details)).toMatchObject({ forgotten: true });
  });

  it("forgets it when the Guardian lifts its own suspension", async () => {
    await seedActor(`${BASE}/users/spammer`);
    await suspendAccount(env, { actorId: `${BASE}/users/spammer`, reason: "duda", source: "heuristic" });
    learnMocks.forgetSuspension.mockClear();

    await unsuspendAccount(env, { actorId: `${BASE}/users/spammer`, reason: "falsa alarma", source: "heuristic" });

    expect(learnMocks.forgetSuspension).toHaveBeenCalledTimes(1);
  });
});
