// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { findTagQuery, replaceTagQuery } from "@/lib/tag-autocomplete";

const mocks = vi.hoisted(() => ({
  all: vi.fn(async () => ({ results: [{ tag: "newspaper", uses: 7, actors: 4 }] })),
  bind: vi.fn(),
  prepare: vi.fn(),
  env: { DB: {}, KV: {} },
}));

vi.mock("@/lib/cf", () => ({
  getCloudflareContext: () => ({ env: mocks.env }),
  json: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
}));

describe("findTagQuery", () => {
  it("finds a hashtag query after whitespace", () => {
    expect(findTagQuery("hello #foo", 10)).toEqual({ start: 6, end: 10, query: "foo" });
  });

  it("triggers at the start of the text", () => {
    expect(findTagQuery("#tag", 4)).toEqual({ start: 0, end: 4, query: "tag" });
  });

  it("does not trigger on URL fragments or mid-word hashes", () => {
    expect(findTagQuery("https://x.com/page#section", 27)).toBeNull();
    expect(findTagQuery("foo#bar", 7)).toBeNull();
  });

  it("requires at least two characters", () => {
    expect(findTagQuery("#a", 2)).toBeNull();
    expect(findTagQuery("#ab", 3)).toEqual({ start: 0, end: 3, query: "ab" });
  });
});

describe("replaceTagQuery", () => {
  it("replaces only the typed hashtag and keeps the rest", () => {
    expect(replaceTagQuery("hello #fo world", { start: 6, end: 9 }, "#foo ")).toBe("hello #foo  world");
  });
});

describe("GET /api/v1/tags/search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepare.mockReturnValue({ bind: mocks.bind });
    mocks.bind.mockReturnValue({ all: mocks.all });
    mocks.env.DB = { prepare: mocks.prepare };
  });

  it("returns Mastodon tag shapes for a prefix query", async () => {
    const { GET } = await import("@/app/api/v1/tags/search/route");
    const res = await GET(
      new Request("https://local.example/api/v1/tags/search?q=%23new&limit=5") as never
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; url: string; history: unknown[] }[];
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("newspaper");
    expect(body[0].url).toBe("https://local.example/tags/newspaper");
    expect(Array.isArray(body[0].history)).toBe(true);
    // Leading `#` and case are trimmed before the LIKE.
    expect(mocks.bind).toHaveBeenCalledWith("new%", expect.any(String), 5);
  });

  it("returns an empty list without a query", async () => {
    const { GET } = await import("@/app/api/v1/tags/search/route");
    const res = await GET(new Request("https://local.example/api/v1/tags/search") as never);
    expect(await res.json()).toEqual([]);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
