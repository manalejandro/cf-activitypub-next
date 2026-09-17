import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LocalActor } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  requireFullAdmin: vi.fn(),
  getActorById: vi.fn(),
  recordModeration: vi.fn(),
  run: vi.fn(),
  first: vi.fn(),
}));

vi.mock("@/lib/cf", () => ({
  getCloudflareContext: () => ({
    env: {
      DB: {
        prepare: () => ({
          bind: (...args: unknown[]) => ({ run: () => mocks.run(...args), first: () => mocks.first(...args) }),
        }),
      },
    },
  }),
  json: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
  notFound: (message = "Not found") =>
    new Response(JSON.stringify({ error: message }), { status: 404, headers: { "Content-Type": "application/json" } }),
}));
vi.mock("@/lib/admin-auth", () => ({ requireFullAdmin: mocks.requireFullAdmin }));
vi.mock("@/lib/db", () => ({ getActorById: mocks.getActorById }));
vi.mock("@/lib/moderation/log", () => ({ recordModeration: mocks.recordModeration }));

type Role = "user" | "moderator" | "admin";

function actor(role: Role, reserved = false): LocalActor {
  return { id: "https://local.example/users/x", role, reserved, isLocal: true } as LocalActor;
}

async function call(route: "promote" | "demote", id = "https://local.example/users/x") {
  const mod = route === "promote"
    ? await import("@/app/api/v1/admin/accounts/[id]/promote/route")
    : await import("@/app/api/v1/admin/accounts/[id]/demote/route");
  const res = await mod.POST(
    new Request("https://local.example/api/v1/admin/accounts/x/" + route, { method: "POST" }) as never,
    { params: Promise.resolve({ id }) }
  );
  return { status: res.status, body: (await res.json()) as { role?: string; changed?: boolean; error?: string } };
}

beforeEach(() => {
  mocks.requireFullAdmin.mockReset().mockResolvedValue(true);
  mocks.getActorById.mockReset();
  mocks.recordModeration.mockReset().mockResolvedValue(undefined);
  mocks.run.mockReset().mockResolvedValue({ meta: { changes: 1 } });
  mocks.first.mockReset().mockResolvedValue({ n: 1 });
});

describe("role promotion", () => {
  it("promotes a user to moderator, then a moderator to admin", async () => {
    mocks.getActorById.mockResolvedValue(actor("user"));
    let result = await call("promote");
    expect(result.body).toEqual({ id: "https://local.example/users/x", role: "moderator", changed: true });
    expect(mocks.run).toHaveBeenCalledWith("moderator", "https://local.example/users/x");

    mocks.getActorById.mockResolvedValue(actor("moderator"));
    result = await call("promote");
    expect(result.body.role).toBe("admin");
    expect(mocks.run).toHaveBeenCalledWith("admin", "https://local.example/users/x");

    expect(mocks.recordModeration).toHaveBeenCalledTimes(2);
  });

  it("never downgrades an existing admin (the old promote did)", async () => {
    mocks.getActorById.mockResolvedValue(actor("admin"));
    const result = await call("promote");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ id: "https://local.example/users/x", role: "admin", changed: false });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("refuses to touch the reserved instance actor", async () => {
    mocks.getActorById.mockResolvedValue(actor("admin", true));
    const result = await call("promote");
    expect(result.status).toBe(422);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("requires a full administrator", async () => {
    mocks.requireFullAdmin.mockResolvedValue(false);
    mocks.getActorById.mockResolvedValue(actor("user"));
    expect((await call("promote")).status).toBe(401);
  });
});

describe("role demotion", () => {
  it("demotes a moderator to user and an admin to moderator", async () => {
    mocks.getActorById.mockResolvedValue(actor("moderator"));
    let result = await call("demote");
    expect(result.body).toEqual({ id: "https://local.example/users/x", role: "user", changed: true });
    expect(mocks.run).toHaveBeenCalledWith("user", "https://local.example/users/x");

    mocks.getActorById.mockResolvedValue(actor("admin"));
    mocks.first.mockResolvedValue({ n: 1 }); // another admin exists
    result = await call("demote");
    expect(result.body.role).toBe("moderator");
    expect(mocks.run).toHaveBeenCalledWith("moderator", "https://local.example/users/x");
  });

  it("protects the last administrator", async () => {
    mocks.getActorById.mockResolvedValue(actor("admin"));
    mocks.first.mockResolvedValue({ n: 0 });
    const result = await call("demote");
    expect(result.status).toBe(422);
    expect(result.body.error).toMatch(/last administrator/);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("does nothing for regular users or reserved actors", async () => {
    mocks.getActorById.mockResolvedValue(actor("user"));
    expect((await call("demote")).status).toBe(422);
    mocks.getActorById.mockResolvedValue(actor("moderator", true));
    expect((await call("demote")).status).toBe(422);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
