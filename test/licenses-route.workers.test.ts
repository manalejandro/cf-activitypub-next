import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/v1/licenses/route";
import { createLicense } from "@/lib/db";
import { installTestContext } from "./helpers/context";
import { applyTestSchema } from "./helpers/db";

/**
 * Route handlers on the real runtime: `installTestContext()` hands the test
 * Worker's bindings to OpenNext's `getCloudflareContext()`, so the handler
 * reads the same D1/KV/R2 the test seeds.
 */
beforeAll(async () => {
  installTestContext();
  await applyTestSchema();
});

// Each test seeds its own catalogue entry, so the file does not depend on
// execution order (storage is isolated per test file, not per test).
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM media_cache").run();
  await env.DB.prepare("DELETE FROM licenses").run();
  await createLicense(env.DB, {
    id: "cc-by-4-0",
    name: "CC BY 4.0",
    url: "https://creativecommons.org/licenses/by/4.0/",
    icon: "",
    badgeKeys: "cc cc-by",
    sortOrder: 10,
    createdAt: "2026-10-04T00:00:00Z",
  });
});

describe("GET /api/v1/licenses (Workers runtime)", () => {
  it("returns the catalogue with badge keys and the derived badges", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; badgeKeys: string; badges: string }[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: "cc-by-4-0",
      badgeKeys: "cc cc-by",
      badges: "cc cc-by",
    });
  });

  it("serves the cached icon when the media cache holds it", async () => {
    await env.DB.prepare(
      `INSERT INTO media_cache (id, source_url, target_type, target_id, status, r2_key, cached_url, size, fetched_at)
       VALUES ('mc1', 'https://licensebuttons.net/l/by/4.0/88x31.png', 'license', 'cc-by-4-0', 'ready',
               'cache/media/icon.png', 'https://cf-ap.com/api/media/cache/media/icon.png', 10, datetime('now'))`
    ).run();
    await env.DB.prepare("UPDATE licenses SET icon = ? WHERE id = 'cc-by-4-0'")
      .bind("https://licensebuttons.net/l/by/4.0/88x31.png")
      .run();

    const res = await GET();
    const body = await res.json() as { icon: string }[];
    // Clients never hotlink the origin: the API serves the R2 copy.
    expect(body[0].icon).toBe("https://cf-ap.com/api/media/cache/media/icon.png");
  });
});
