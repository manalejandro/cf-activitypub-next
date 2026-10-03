// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
  getAdminRole: vi.fn(),
  requireAdmin: vi.fn(),
  listLicenses: vi.fn(async (): Promise<unknown> => []),
  getLicenseById: vi.fn(async (): Promise<unknown> => null),
  getLicenseByUrl: vi.fn(async (): Promise<unknown> => null),
  createLicense: vi.fn(async () => {}),
  updateLicense: vi.fn(async () => {}),
  deleteLicense: vi.fn(async () => {}),
  recordModeration: vi.fn(async () => {}),
}));

vi.mock("@/lib/cf", () => ({
  getCloudflareContext: mocks.getCloudflareContext,
  json: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
  badRequest: (message = "Bad request") =>
    new Response(JSON.stringify({ error: message }), { status: 422, headers: { "Content-Type": "application/json" } }),
}));
vi.mock("@/lib/admin-auth", () => ({
  getAdminRole: mocks.getAdminRole,
  requireAdmin: mocks.requireAdmin,
}));
vi.mock("@/lib/db", () => ({
  listLicenses: mocks.listLicenses,
  getLicenseById: mocks.getLicenseById,
  getLicenseByUrl: mocks.getLicenseByUrl,
  createLicense: mocks.createLicense,
  updateLicense: mocks.updateLicense,
  deleteLicense: mocks.deleteLicense,
}));
vi.mock("@/lib/moderation/log", () => ({ recordModeration: mocks.recordModeration }));

import { GET, POST } from "@/app/api/v1/admin/licenses/route";

const LICENSE = {
  id: "cc-by-4-0",
  name: "CC BY 4.0",
  url: "https://creativecommons.org/licenses/by/4.0/",
  icon: "",
  sortOrder: 10,
  createdAt: "2026-10-03T00:00:00Z",
};

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("https://cf-ap.com/api/v1/admin/licenses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCloudflareContext.mockReturnValue({ env: { DB: {} } });
  mocks.requireAdmin.mockResolvedValue(true);
  mocks.getAdminRole.mockResolvedValue("admin");
  mocks.listLicenses.mockResolvedValue([LICENSE]);
  mocks.getLicenseById.mockResolvedValue(null);
  mocks.getLicenseByUrl.mockResolvedValue(null);
});

describe("GET /api/v1/admin/licenses", () => {
  it("rejects anonymous callers", async () => {
    mocks.requireAdmin.mockResolvedValue(false);
    expect((await GET(makeRequest({}) as never)).status).toBe(401);
  });

  it("lists the catalogue for an admin", async () => {
    const res = await GET(makeRequest({}) as never);
    expect(res.status).toBe(200);
    expect((await res.json() as { licenses: unknown[] }).licenses).toHaveLength(1);
  });
});

describe("POST /api/v1/admin/licenses", () => {
  it("requires a full administrator", async () => {
    mocks.getAdminRole.mockResolvedValue("moderator");
    const res = await POST(makeRequest({ action: "add", name: "X", url: "https://example.com/l" }) as never);
    expect(res.status).toBe(403);
    expect(mocks.createLicense).not.toHaveBeenCalled();
  });

  it("rejects a missing name or a non-https URL", async () => {
    expect((await POST(makeRequest({ action: "add", name: "", url: "https://example.com/l" }) as never)).status).toBe(422);
    expect((await POST(makeRequest({ action: "add", name: "X", url: "http://example.com/l" }) as never)).status).toBe(422);
    expect(mocks.createLicense).not.toHaveBeenCalled();
  });

  it("adds a catalogue entry and audits it", async () => {
    const res = await POST(makeRequest({ action: "add", name: "CC BY 4.0", url: LICENSE.url }) as never);
    expect(res.status).toBe(200);
    expect(mocks.createLicense).toHaveBeenCalledTimes(1);
    const [, created] = mocks.createLicense.mock.calls[0] as unknown as [unknown, { id: string; name: string; url: string }];
    expect(created.id).toBe("cc-by-4-0");
    expect(created.url).toBe(LICENSE.url);
    expect(mocks.recordModeration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "license_added", targetType: "license" })
    );
  });

  it("refuses a duplicate id or URL", async () => {
    mocks.getLicenseById.mockResolvedValue(LICENSE);
    expect((await POST(makeRequest({ action: "add", name: "CC BY 4.0", url: LICENSE.url }) as never)).status).toBe(422);
    mocks.getLicenseById.mockResolvedValue(null);
    mocks.getLicenseByUrl.mockResolvedValue(LICENSE);
    expect((await POST(makeRequest({ action: "add", name: "Otra", url: LICENSE.url }) as never)).status).toBe(422);
    expect(mocks.createLicense).not.toHaveBeenCalled();
  });

  it("updates an entry", async () => {
    mocks.getLicenseById.mockResolvedValue(LICENSE);
    const res = await POST(makeRequest({ action: "update", id: LICENSE.id, name: "CC BY 4.0 (editada)" }) as never);
    expect(res.status).toBe(200);
    expect(mocks.updateLicense).toHaveBeenCalledWith(
      expect.anything(),
      LICENSE.id,
      expect.objectContaining({ name: "CC BY 4.0 (editada)" })
    );
  });

  it("deletes an entry (published posts keep their license URL)", async () => {
    mocks.getLicenseById.mockResolvedValue(LICENSE);
    const res = await POST(makeRequest({ action: "delete", id: LICENSE.id }) as never);
    expect(res.status).toBe(200);
    expect(mocks.deleteLicense).toHaveBeenCalledWith(expect.anything(), LICENSE.id);
    expect(mocks.recordModeration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "license_removed" })
    );
  });

  it("404s for an unknown entry and 422 for an unknown action", async () => {
    expect((await POST(makeRequest({ action: "delete", id: "nope" }) as never)).status).toBe(404);
    mocks.getLicenseById.mockResolvedValue(LICENSE);
    expect((await POST(makeRequest({ action: "explode", id: LICENSE.id }) as never)).status).toBe(422);
  });
});
