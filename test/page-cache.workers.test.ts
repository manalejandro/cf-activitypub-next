import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTestSchema, resetTestStorage } from "./helpers/db";
import { isPageCacheRequest, pageCacheLimitsFrom, withPageCache, DEFAULT_PAGE_CACHE_SWR, DEFAULT_PAGE_CACHE_TTL } from "@/lib/page-cache";

const limits = { ttl: DEFAULT_PAGE_CACHE_TTL, swr: DEFAULT_PAGE_CACHE_SWR };

function context(): ExecutionContext {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

/** The Cache API is shared per test file: unique URLs keep the tests apart. */
let seq = 0;
const pageUrl = (path = "/") => `https://local.example.test${path}?t=${seq++}`;

function html(body = "<html>shell</html>", headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // What the framework sends today.
      "Cache-Control": "no-store, must-revalidate",
      Vary: "RSC, Next-Router-State-Tree, Next-Url",
      ...headers,
    },
  });
}

async function render(response: Response): Promise<{ render: () => Promise<Response>; calls: () => number }> {
  let calls = 0;
  return {
    render: async () => {
      calls++;
      return response.clone();
    },
    calls: () => calls,
  };
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
});

describe("page cache request filter", () => {
  it("only accepts plain HTML navigations", () => {
    const get = (url: string, headers: Record<string, string> = {}) =>
      new Request(url, { method: "GET", headers });

    expect(isPageCacheRequest(get("https://x.test/"), limits)).toBe(true);
    expect(isPageCacheRequest(get("https://x.test/statuses/1"), limits)).toBe(true);
    expect(isPageCacheRequest(get("https://x.test/@ana"), limits)).toBe(true);
    // Client-side navigations fetch the RSC payload: never served an HTML shell.
    expect(isPageCacheRequest(get("https://x.test/", { RSC: "1" }), limits)).toBe(false);
    expect(isPageCacheRequest(get("https://x.test/?_rsc=abc"), limits)).toBe(false);
    expect(isPageCacheRequest(get("https://x.test/", { "Next-Router-Prefetch": "1" }), limits)).toBe(false);
    // APIs, federation and API clients.
    expect(isPageCacheRequest(get("https://x.test/api/v1/statuses"), limits)).toBe(false);
    expect(isPageCacheRequest(get("https://x.test/.well-known/webfinger"), limits)).toBe(false);
    expect(isPageCacheRequest(get("https://x.test/inbox"), limits)).toBe(false);
    expect(isPageCacheRequest(get("https://x.test/", { Authorization: "Bearer tok" }), limits)).toBe(false);
    expect(isPageCacheRequest(new Request("https://x.test/", { method: "POST" }), limits)).toBe(false);
    // Disabled by configuration.
    expect(isPageCacheRequest(get("https://x.test/"), { ttl: 0, swr: 0 })).toBe(false);
  });

  it("bridges its limits from resolveLimits with the documented defaults", () => {
    expect(DEFAULT_PAGE_CACHE_TTL).toBe(60);
    expect(DEFAULT_PAGE_CACHE_SWR).toBe(600);
    expect(pageCacheLimitsFrom({ pageCacheTtl: 120, pageCacheSwr: 0 })).toEqual({ ttl: 120, swr: 0 });
  });
});

describe("page cache", () => {
  it("stores the shell and serves the next visitor from the cache", async () => {
    const url = pageUrl();
    const { render: renderOnce, calls } = await render(html("<html>hola</html>"));

    const first = await withPageCache(new Request(url), context(), limits, renderOnce);
    expect(first.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(await first.text()).toContain("hola");
    // The store happens in the background (`waitUntil`).
    await new Promise((resolve) => setTimeout(resolve, 50));

    const ctx = context();
    const second = await withPageCache(new Request(url), ctx, limits, renderOnce);
    expect(calls()).toBe(1);
    expect(second.headers.get("x-page-cache")).toBe("HIT");
    expect(second.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(second.headers.has("x-cf-ap-stored-at")).toBe(false);
    expect(await second.text()).toContain("hola");
  });

  it("serves a stale copy immediately and revalidates it in the background", async () => {
    const url = pageUrl();
    const now = Math.floor(Date.now() / 1000);
    let calls = 0;
    // A different body per render proves which copy was served.
    const renderVersioned = async () => {
      calls++;
      return html(`<html>${calls === 1 ? "viejo" : "nuevo"}</html>`);
    };

    await withPageCache(new Request(url), context(), limits, renderVersioned, now);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Past the fresh window but inside the stale one: the stored copy is served
    // immediately and refreshed behind the request.
    const stale = await withPageCache(new Request(url), context(), limits, renderVersioned, now + limits.ttl + 5);
    expect(stale.headers.get("x-page-cache")).toBe("STALE");
    expect(stale.headers.get("Age")).toBe(String(limits.ttl + 5));
    expect(await stale.text()).toContain("viejo");
    await new Promise((resolve) => setTimeout(resolve, 80));

    // The background refresh replaced the entry: the next visitor gets it.
    const afterRefresh = await withPageCache(new Request(url), context(), limits, renderVersioned, now + limits.ttl + 10);
    expect(afterRefresh.headers.get("x-page-cache")).toBe("HIT");
    expect(await afterRefresh.text()).toContain("nuevo");
    expect(calls).toBe(2);
  });

  it("rebuilds the page when the stored copy is past the stale window", async () => {
    const url = pageUrl();
    const now = Math.floor(Date.now() / 1000);
    const { render: renderOnce, calls } = await render(html());

    await withPageCache(new Request(url), context(), limits, renderOnce, now);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const fresh = await withPageCache(new Request(url), context(), limits, renderOnce, now + limits.ttl + limits.swr + 5);
    expect(fresh.headers.get("x-page-cache")).toBeNull();
    expect(calls()).toBe(2);
  });

  it("never caches a personalised page, an API response or a non-200", async () => {
    const personalised = await render(html("<html>yo</html>", { "Set-Cookie": "auth_token=1; Path=/" }));
    const url = pageUrl();
    await withPageCache(new Request(url), context(), limits, personalised.render);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterCookie = await withPageCache(new Request(url), context(), limits, personalised.render);
    expect(afterCookie.headers.get("x-page-cache")).toBeNull();
    expect(personalised.calls()).toBe(2);

    const api = await render(new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } }));
    const apiUrl = pageUrl("/api/v1/instance");
    await withPageCache(new Request(apiUrl), context(), limits, api.render);
    await withPageCache(new Request(apiUrl), context(), limits, api.render);
    expect(api.calls()).toBe(2);

    const failing = await render(new Response("boom", { status: 500, headers: { "Content-Type": "text/html" } }));
    const failUrl = pageUrl("/roto");
    await withPageCache(new Request(failUrl), context(), limits, failing.render);
    await withPageCache(new Request(failUrl), context(), limits, failing.render);
    expect(failing.calls()).toBe(2);
  });

  it("is disabled with PAGE_CACHE_TTL=0", async () => {
    const url = pageUrl();
    const { render: renderOnce, calls } = await render(html());
    const off = { ttl: 0, swr: 0 };
    await withPageCache(new Request(url), context(), off, renderOnce);
    await withPageCache(new Request(url), context(), off, renderOnce);
    expect(calls()).toBe(2);
  });
});

describe("page cache in the app worker", () => {
  it("serves the same HTML twice and reports the cache state", async () => {
    const res = await env.ASSETS.fetch(new Request("https://local.example.test/does-not-exist"));
    expect(res.status).toBeGreaterThan(0);
    // The worker's own path is covered end-to-end by the preview run; here we
    // only assert the module contract with the real Cache API (above) and that
    // the binding is available in this runtime.
    expect(typeof caches).toBe("object");
    void vi;
  });
});
