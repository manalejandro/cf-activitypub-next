import { describe, it, expect, vi, beforeEach } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import type { LocalActor } from "@/lib/types";

const authMocks = vi.hoisted(() => ({ getAuthenticatedActor: vi.fn() }));

vi.mock("@/lib/auth", () => ({ getAuthenticatedActor: authMocks.getAuthenticatedActor }));

import { getAdminRole, requireAdmin, requireFullAdmin } from "@/lib/admin-auth";

function fakeDb(role: string | null): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => (role ? { role } : null),
      }),
    }),
  } as unknown as D1Database;
}

function env(role: string | null): { DB: D1Database } {
  return { DB: fakeDb(role) };
}

function request(token?: string): Request {
  return new Request("https://local.example/api/v1/admin/instance_settings", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

const actor = (role?: string): LocalActor =>
  ({ id: "https://local.example/users/ale", role }) as LocalActor;

beforeEach(() => {
  authMocks.getAuthenticatedActor.mockReset();
});

describe("admin authorization", () => {
  it("grants moderators read access but not full-admin", async () => {
    authMocks.getAuthenticatedActor.mockResolvedValue(actor("moderator"));
    expect(await getAdminRole(request(), env(null))).toBe("moderator");
    expect(await requireAdmin(request(), env(null))).toBe(true);
    expect(await requireFullAdmin(request(), env(null))).toBe(false);
  });

  it("grants full admins everything", async () => {
    authMocks.getAuthenticatedActor.mockResolvedValue(actor("admin"));
    expect(await getAdminRole(request(), env(null))).toBe("admin");
    expect(await requireFullAdmin(request(), env(null))).toBe(true);
  });

  it("resolves the role from the database when the actor row omits it", async () => {
    authMocks.getAuthenticatedActor.mockResolvedValue(actor(undefined));
    expect(await getAdminRole(request(), env("admin"))).toBe("admin");
    expect(await getAdminRole(request(), env("moderator"))).toBe("moderator");
    expect(await getAdminRole(request(), env("user"))).toBeNull();
  });

  it("rejects anonymous callers", async () => {
    authMocks.getAuthenticatedActor.mockResolvedValue(null);
    expect(await getAdminRole(request(), env("admin"))).toBeNull();
    expect(await requireAdmin(request(), env(null))).toBe(false);
  });

  it("treats a matching ADMIN_TOKEN as a full admin", async () => {
    authMocks.getAuthenticatedActor.mockResolvedValue(null);
    const withToken = { DB: fakeDb(null), ADMIN_TOKEN: "s3cret" };
    expect(await getAdminRole(request("s3cret"), withToken)).toBe("admin");
    expect(await requireFullAdmin(request("s3cret"), withToken)).toBe(true);
    expect(await getAdminRole(request("wrong"), withToken)).toBeNull();
  });
});
