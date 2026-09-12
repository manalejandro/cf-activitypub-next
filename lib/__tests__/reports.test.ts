import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockGetReportById = vi.hoisted(() => vi.fn());
const mockGetActorById = vi.hoisted(() => vi.fn());
const mockGetObjectById = vi.hoisted(() => vi.fn());
const mockGetReportNotes = vi.hoisted(() => vi.fn());
const mockCreateReportNote = vi.hoisted(() => vi.fn());
const mockRequireAdmin = vi.hoisted(() => vi.fn());
const mockGetAuthenticatedActor = vi.hoisted(() => vi.fn());
const mockSerializeAccount = vi.hoisted(() => vi.fn());
const mockDecodeStatusId = vi.hoisted(() => vi.fn());
const mockGenerateId = vi.hoisted(() => vi.fn());

const mockDb = vi.hoisted(() => {
  const chain = {
    bind: vi.fn(function (this: typeof chain) { return this; }),
    first: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue({ results: [] }),
    run: vi.fn().mockResolvedValue({ success: true }),
  };
  return {
    prepare: vi.fn(() => chain),
    batch: vi.fn().mockResolvedValue([]),
    __chain: chain,
  };
});

vi.mock("@/lib/cf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cf")>();
  return {
    ...actual,
    getCloudflareContext: () => ({ env: { DB: mockDb } }),
  };
});

vi.mock("@/lib/db", () => ({
  getReportById: mockGetReportById,
  getActorById: mockGetActorById,
  getObjectById: mockGetObjectById,
  getReportNotes: mockGetReportNotes,
  createReportNote: mockCreateReportNote,
}));

vi.mock("@/lib/admin-auth", () => ({
  requireAdmin: mockRequireAdmin,
}));

vi.mock("@/lib/auth", () => ({
  getAuthenticatedActor: mockGetAuthenticatedActor,
}));

vi.mock("@/lib/mastodon/serializers", () => ({
  serializeAccount: mockSerializeAccount,
}));

vi.mock("@/lib/mastodon/statusId", () => ({
  decodeStatusId: mockDecodeStatusId,
}));

vi.mock("@/lib/activitypub/utils", () => ({
  generateId: mockGenerateId,
}));

const REPORT = {
  id: "r1",
  actor_id: "a-reporter",
  target_id: "a-target",
  status_ids: null,
  comment: "Spam account",
  category: "spam",
  rule_ids: null,
  forwarded: false,
  action_taken: false,
  created_at: "2026-01-01T00:00:00.000Z",
};

const TARGET = { id: "a-target", username: "spammer" };

function makeRequest(method: string, url = "https://example.test/api/v1/admin/reports/r1"): NextRequest {
  return new Request(url, { method }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.__chain.all.mockResolvedValue({ results: [] });
  mockDb.__chain.first.mockResolvedValue(null);
  mockDb.__chain.run.mockResolvedValue({ success: true });
  mockSerializeAccount.mockImplementation((a: { id: string; username: string }) => ({ id: a.id, username: a.username, acct: a.username }));
  mockDecodeStatusId.mockImplementation((id: string) => id);
  mockGetActorById.mockResolvedValue(TARGET);
  mockGetObjectById.mockResolvedValue(null);
  mockGetReportNotes.mockResolvedValue([]);
});

// ─── DELETE /api/v1/admin/reports/:id ──────────────────────────────────────

describe("DELETE /api/v1/admin/reports/:id", () => {
  async function importRoute() {
    return await import("@/app/api/v1/admin/reports/[id]/route");
  }

  it("returns 401 when caller is not admin", async () => {
    mockRequireAdmin.mockResolvedValue(false);
    const { DELETE } = await importRoute();
    const res = await DELETE(makeRequest("DELETE"), { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(401);
    expect(mockDb.batch).not.toHaveBeenCalled();
  });

  it("returns 404 when report does not exist", async () => {
    mockRequireAdmin.mockResolvedValue(true);
    mockGetReportById.mockResolvedValue(null);
    const { DELETE } = await importRoute();
    const res = await DELETE(makeRequest("DELETE"), { params: Promise.resolve({ id: "missing" }) });
    expect(res.status).toBe(404);
    expect(mockDb.batch).not.toHaveBeenCalled();
  });

  it("returns 422 when report is not resolved", async () => {
    mockRequireAdmin.mockResolvedValue(true);
    mockGetReportById.mockResolvedValue({ ...REPORT, action_taken: false });
    const { DELETE } = await importRoute();
    const res = await DELETE(makeRequest("DELETE"), { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("resolved");
    expect(mockDb.batch).not.toHaveBeenCalled();
  });

  it("deletes the report and its notes when resolved", async () => {
    mockRequireAdmin.mockResolvedValue(true);
    mockGetReportById.mockResolvedValue({ ...REPORT, action_taken: true });
    const { DELETE } = await importRoute();
    const res = await DELETE(makeRequest("DELETE"), { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: "r1", deleted: true });
    expect(mockDb.batch).toHaveBeenCalledTimes(1);
    const [noteDelete, reportDelete] = mockDb.batch.mock.calls[0][0];
    expect(noteDelete.bind).toHaveBeenCalledWith("r1");
    expect(reportDelete.bind).toHaveBeenCalledWith("r1");
  });
});

// ─── POST /api/v1/admin/reports/:id/resolve ────────────────────────────────

describe("POST /api/v1/admin/reports/:id/resolve", () => {
  async function importRoute() {
    return await import("@/app/api/v1/admin/reports/[id]/resolve/route");
  }

  it("returns 401 when caller is not admin", async () => {
    mockRequireAdmin.mockResolvedValue(false);
    const { POST } = await importRoute();
    const res = await POST(makeRequest("POST"), { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 404 when report does not exist", async () => {
    mockRequireAdmin.mockResolvedValue(true);
    mockGetReportById.mockResolvedValue(null);
    const { POST } = await importRoute();
    const res = await POST(makeRequest("POST"), { params: Promise.resolve({ id: "missing" }) });
    expect(res.status).toBe(404);
  });

  it("marks the report as action_taken", async () => {
    mockRequireAdmin.mockResolvedValue(true);
    mockGetReportById.mockResolvedValueOnce({ ...REPORT, action_taken: false })
      .mockResolvedValueOnce({ ...REPORT, action_taken: true });
    const { POST } = await importRoute();
    const res = await POST(makeRequest("POST"), { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { action_taken: boolean };
    expect(body.action_taken).toBe(true);
    expect(mockDb.prepare).toHaveBeenCalledWith("UPDATE reports SET action_taken = 1 WHERE id = ?");
  });
});

// ─── POST /api/v1/admin/reports/:id/reopen ─────────────────────────────────

describe("POST /api/v1/admin/reports/:id/reopen", () => {
  async function importRoute() {
    return await import("@/app/api/v1/admin/reports/[id]/reopen/route");
  }

  it("returns 401 when caller is not admin", async () => {
    mockRequireAdmin.mockResolvedValue(false);
    const { POST } = await importRoute();
    const res = await POST(makeRequest("POST"), { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 404 when report does not exist", async () => {
    mockRequireAdmin.mockResolvedValue(true);
    mockGetReportById.mockResolvedValue(null);
    const { POST } = await importRoute();
    const res = await POST(makeRequest("POST"), { params: Promise.resolve({ id: "missing" }) });
    expect(res.status).toBe(404);
  });

  it("reopens the report (action_taken = 0)", async () => {
    mockRequireAdmin.mockResolvedValue(true);
    mockGetReportById.mockResolvedValue({ ...REPORT, action_taken: true });
    const { POST } = await importRoute();
    const res = await POST(makeRequest("POST"), { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: "r1", action_taken: false, reopened: true });
    expect(mockDb.prepare).toHaveBeenCalledWith("UPDATE reports SET action_taken = 0 WHERE id = ?");
  });
});

// ─── POST /api/v1/admin/reports/:id/notes ──────────────────────────────────

describe("POST /api/v1/admin/reports/:id/notes", () => {
  async function importRoute() {
    return await import("@/app/api/v1/admin/reports/[id]/notes/route");
  }

  function postRequest(content?: string): NextRequest {
    return new Request("https://example.test/api/v1/admin/reports/r1/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }) as unknown as NextRequest;
  }

  it("returns 401 when caller is not admin", async () => {
    mockRequireAdmin.mockResolvedValue(false);
    const { POST } = await importRoute();
    const res = await POST(postRequest("hello"), { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 404 when report does not exist", async () => {
    mockRequireAdmin.mockResolvedValue(true);
    mockGetReportById.mockResolvedValue(null);
    const { POST } = await importRoute();
    const res = await POST(postRequest("hello"), { params: Promise.resolve({ id: "missing" }) });
    expect(res.status).toBe(404);
  });

  it("returns 422 when content is empty", async () => {
    mockRequireAdmin.mockResolvedValue(true);
    mockGetReportById.mockResolvedValue(REPORT);
    mockGetAuthenticatedActor.mockResolvedValue({ id: "a-mod", username: "mod", role: "moderator" });
    const { POST } = await importRoute();
    const res = await POST(postRequest("   "), { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(422);
    expect(mockCreateReportNote).not.toHaveBeenCalled();
  });

  it("creates an internal note with the acting moderator as author", async () => {
    mockRequireAdmin.mockResolvedValue(true);
    mockGetReportById.mockResolvedValue(REPORT);
    mockGetAuthenticatedActor.mockResolvedValue({ id: "a-mod", username: "mod", role: "moderator" });
    mockGenerateId.mockReturnValue("note-1");
    mockCreateReportNote.mockResolvedValue(undefined);
    mockGetActorById.mockResolvedValue({ id: "a-mod", username: "mod" });

    const { POST } = await importRoute();
    const res = await POST(postRequest("  Keep an eye on this  "), { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; report_id: string; content: string; account: { username: string } };
    expect(body.id).toBe("note-1");
    expect(body.report_id).toBe("r1");
    expect(body.content).toBe("Keep an eye on this");
    expect(body.account.username).toBe("mod");
    expect(mockCreateReportNote).toHaveBeenCalledWith(mockDb, "note-1", "r1", "a-mod", "Keep an eye on this");
  });
});

// ─── GET /api/v1/admin/reports (list) ──────────────────────────────────────

describe("GET /api/v1/admin/reports", () => {
  async function importRoute() {
    return await import("@/app/api/v1/admin/reports/route");
  }

  it("returns 401 when caller is not admin", async () => {
    mockRequireAdmin.mockResolvedValue(false);
    const { GET } = await importRoute();
    const res = await GET(makeRequest("GET", "https://example.test/api/v1/admin/reports"));
    expect(res.status).toBe(401);
  });

  it("returns an empty list when no reports exist", async () => {
    mockRequireAdmin.mockResolvedValue(true);
    mockDb.__chain.all.mockResolvedValue({ results: [] });
    const { GET } = await importRoute();
    const res = await GET(makeRequest("GET", "https://example.test/api/v1/admin/reports"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reports: [], total: 0 });
  });

  it("includes notes and serialized accounts in each report", async () => {
    mockRequireAdmin.mockResolvedValue(true);
    mockDb.__chain.all.mockResolvedValue({ results: [REPORT] });
    mockGetReportNotes.mockResolvedValue([
      { id: "n1", report_id: "r1", actor_id: "a-mod", content: "noted", created_at: "2026-01-02T00:00:00.000Z" },
    ]);
    mockGetActorById.mockImplementation(async (_db: unknown, id: string) => (id === "a-target" ? TARGET : { id: "a-reporter", username: "reporter" }));

    const { GET } = await importRoute();
    const res = await GET(makeRequest("GET", "https://example.test/api/v1/admin/reports"));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      reports: Array<{
        id: string;
        target_account: { username: string };
        reporter_account: { username: string };
        notes: Array<{ id: string; content: string; created_at: string }>;
      }>;
      total: number;
    };
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0].id).toBe("r1");
    expect(body.reports[0].target_account.username).toBe("spammer");
    expect(body.reports[0].reporter_account.username).toBe("reporter");
    expect(body.reports[0].notes).toEqual([
      { id: "n1", content: "noted", created_at: "2026-01-02T00:00:00.000Z" },
    ]);
    expect(mockGetReportNotes).toHaveBeenCalledWith(mockDb, "r1");
  });
});