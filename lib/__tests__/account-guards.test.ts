import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LocalActor } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getAdminRole: vi.fn(),
  getAuthenticatedActor: vi.fn(),
  countUsableAdmins: vi.fn(),
}));

vi.mock("@/lib/cf", () => ({
  json: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
}));
vi.mock("@/lib/admin-auth", () => ({ getAdminRole: mocks.getAdminRole }));
vi.mock("@/lib/auth", () => ({ getAuthenticatedActor: mocks.getAuthenticatedActor }));
vi.mock("@/lib/db", () => ({ countUsableAdmins: mocks.countUsableAdmins }));

import { accountActionGuard } from "@/lib/admin/account-guards";

const env = { DB: {} } as unknown as { DB: D1Database };

function target(over: Partial<LocalActor> = {}): Pick<LocalActor, "id" | "role" | "reserved"> {
  return { id: "https://local.example/users/x", role: "user", reserved: false, ...over };
}

beforeEach(() => {
  mocks.getAdminRole.mockReset().mockResolvedValue("admin");
  mocks.getAuthenticatedActor.mockReset().mockResolvedValue({ id: "https://local.example/users/me" });
  mocks.countUsableAdmins.mockReset().mockResolvedValue(1);
});

describe("accountActionGuard", () => {
  it("refuses to touch the reserved instance actor", async () => {
    const res = await accountActionGuard(new Request("https://local.example"), env, target({ reserved: true }));
    expect(res?.status).toBe(422);
  });

  it("refuses acting on your own account through the admin API", async () => {
    mocks.getAuthenticatedActor.mockResolvedValue({ id: "https://local.example/users/x" });
    const res = await accountActionGuard(new Request("https://local.example"), env, target());
    expect(res?.status).toBe(422);
  });

  it("requires a full admin to act on an administrator", async () => {
    mocks.getAdminRole.mockResolvedValue("moderator");
    const res = await accountActionGuard(new Request("https://local.example"), env, target({ role: "admin" }));
    expect(res?.status).toBe(403);
  });

  it("protects the last administrator's access when the action removes it", async () => {
    mocks.countUsableAdmins.mockResolvedValue(0);
    const res = await accountActionGuard(new Request("https://local.example"), env, target({ role: "admin" }), {
      removesAccess: true,
    });
    expect(res?.status).toBe(422);

    // Without removesAccess (e.g. unsuspend) the last admin can be acted on.
    const soft = await accountActionGuard(new Request("https://local.example"), env, target({ role: "admin" }));
    expect(soft).toBeNull();
  });

  it("allows a full admin to act when another admin remains", async () => {
    mocks.countUsableAdmins.mockResolvedValue(1);
    const res = await accountActionGuard(new Request("https://local.example"), env, target({ role: "admin" }), {
      removesAccess: true,
    });
    expect(res).toBeNull();
  });

  it("allows acting on regular accounts", async () => {
    const res = await accountActionGuard(new Request("https://local.example"), env, target());
    expect(res).toBeNull();
  });
});
