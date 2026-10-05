import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchBlockedAccounts,
  invalidateBlockedAccounts,
  statusTouchesBlocked,
  type BlockedAccounts,
} from "@/lib/streaming/blocked-accounts";

vi.mock("@/lib/client-api", () => ({ getToken: () => "token" }));

const blocked: BlockedAccounts = {
  ids: new Set(["https://remote.example/users/bad"]),
  domains: new Set(["baddomain.example"]),
};

describe("statusTouchesBlocked", () => {
  it("matches the author, a reply parent, a boosted author and blocked domains", () => {
    expect(statusTouchesBlocked({ account: { id: "https://remote.example/users/bad" } }, blocked)).toBe(true);
    expect(
      statusTouchesBlocked(
        { account: { id: "https://ok.example/users/x" }, in_reply_to_account_id: "https://remote.example/users/bad" },
        blocked
      )
    ).toBe(true);
    expect(
      statusTouchesBlocked(
        { account: { id: "https://ok.example/users/x" }, reblog: { account: { id: "https://remote.example/users/bad" } } },
        blocked
      )
    ).toBe(true);
    expect(statusTouchesBlocked({ account: { id: "https://baddomain.example/users/x" } }, blocked)).toBe(true);
    expect(statusTouchesBlocked({ account: { id: "https://ok.example/users/x", acct: "x@baddomain.example" } }, blocked)).toBe(true);
    expect(statusTouchesBlocked({ account: { id: "https://ok.example/users/x" } }, blocked)).toBe(false);
    expect(statusTouchesBlocked({}, blocked)).toBe(false);
  });

  it("never filters with an empty block list", () => {
    const empty: BlockedAccounts = { ids: new Set(), domains: new Set() };
    expect(statusTouchesBlocked({ account: { id: "https://remote.example/users/bad" } }, empty)).toBe(false);
  });
});

describe("fetchBlockedAccounts", () => {
  beforeEach(() => {
    invalidateBlockedAccounts();
    vi.restoreAllMocks();
  });

  it("walks every blocks page, adapting to the server page cap", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/v1/blocks")) {
        const offset = Number(new URL(url, "https://local.test").searchParams.get("offset"));
        // The server caps `limit` at 40 (maxCollectionPage): a fixed 80-step
        // walk would skip accounts 40-79.
        const count = offset === 0 || offset === 40 ? 40 : offset === 80 ? 5 : 0;
        const page = Array.from({ length: count }, (_, i) => ({ id: `https://remote.example/users/${offset + i}` }));
        return new Response(JSON.stringify(page), { status: 200 });
      }
      return new Response(JSON.stringify(["Bad.Example"]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchBlockedAccounts();
    expect(result.ids.size).toBe(85);
    expect(result.ids.has("https://remote.example/users/84")).toBe(true);
    expect([...result.domains]).toEqual(["bad.example"]);
    // Three blocks pages plus the domain list.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("caches the result until invalidated", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchBlockedAccounts();
    await fetchBlockedAccounts();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    invalidateBlockedAccounts();
    await fetchBlockedAccounts();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
  });
});
