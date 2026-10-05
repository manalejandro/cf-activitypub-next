import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createLicense, getLicenseById, listLicenses, updateLicense } from "@/lib/db";
import { applyTestSchema } from "./helpers/db";

/**
 * Integration tests on the real Workers runtime: the bindings come from
 * wrangler.toml through Miniflare, so D1 here is actual SQLite with the schema
 * applied verbatim (no node:sqlite shim).
 */
beforeAll(async () => {
  await applyTestSchema();
});

describe("D1 binding", () => {
  it("stores, updates and lists a license on the real database", async () => {
    await createLicense(env.DB, {
      id: "mi-lic",
      name: "Mi licencia",
      url: "https://otra.example/licenses/mi-lic",
      icon: "",
      badgeKeys: "cc cc-by",
      sortOrder: 10,
      createdAt: "2026-10-04T00:00:00Z",
    });

    expect((await getLicenseById(env.DB, "mi-lic"))?.badgeKeys).toBe("cc cc-by");

    await updateLicense(env.DB, "mi-lic", { badgeKeys: "copyright" });
    expect((await getLicenseById(env.DB, "mi-lic"))?.badgeKeys).toBe("copyright");

    expect((await listLicenses(env.DB)).map((l) => l.id)).toContain("mi-lic");
  });

  it("enforces the schema constraints", async () => {
    await createLicense(env.DB, {
      id: "dup",
      name: "Otra",
      url: "https://otra.example/licenses/dup",
      icon: "",
      badgeKeys: "",
      sortOrder: 20,
      createdAt: "2026-10-04T00:00:00Z",
    });

    // `url` is UNIQUE: the same canonical URI cannot be registered twice.
    await expect(
      createLicense(env.DB, {
        id: "dup-2",
        name: "Duplicada",
        url: "https://otra.example/licenses/dup",
        icon: "",
        badgeKeys: "",
        sortOrder: 30,
        createdAt: "2026-10-04T00:00:00Z",
      })
    ).rejects.toThrow();
  });
});

describe("KV and R2 bindings", () => {
  it("exposes the wrangler.toml vars", () => {
    expect(env.INSTANCE_URL).toBe("https://cf-ap.com");
  });

  it("round-trips KV values and R2 objects", async () => {
    await env.KV.put("test-key", "test-value");
    expect(await env.KV.get("test-key")).toBe("test-value");

    await env.R2.put("test/object.txt", "hola");
    const object = await env.R2.get("test/object.txt");
    expect(await object?.text()).toBe("hola");
  });
});
