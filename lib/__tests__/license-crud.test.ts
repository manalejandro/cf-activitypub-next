// @vitest-environment node
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Database, D1Result } from "@cloudflare/workers-types";

import { createLicense, deleteLicense, getLicenseById, listLicenses, updateLicense } from "@/lib/db";

class D1Adapter {
  private sql = new DatabaseSync(":memory:");

  constructor(schemaSql: string) {
    this.sql.exec(schemaSql);
  }

  prepare(query: string) {
    const stmt = this.sql.prepare(query);
    return {
      bind(...params: unknown[]) {
        return {
          async all<T = unknown>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }> {
            return { results: stmt.all(...(params as never[])) as unknown as T[], success: true, meta: {} };
          },
          async first<T = unknown>(): Promise<T | null> {
            return (stmt.get(...(params as never[])) as unknown as T | undefined) ?? null;
          },
          async run(): Promise<D1Result> {
            const info = stmt.run(...(params as never[]));
            return { success: true, meta: { changes: info.changes }, results: [] } as unknown as D1Result<unknown>;
          },
        };
      },
    };
  }
}

const db = new D1Adapter(readFileSync(join(process.cwd(), "lib/db/schema.sql"), "utf8")) as unknown as D1Database;

describe("license catalogue CRUD", () => {
  it("stores, edits and clears the Fork Awesome badge keys", async () => {
    await createLicense(db, {
      id: "mi-lic",
      name: "Mi licencia",
      url: "https://otra.example/licenses/mi-lic",
      icon: "",
      badgeKeys: "cc cc-by",
      sortOrder: 10,
      createdAt: "2026-10-03T00:00:00Z",
    });
    expect((await getLicenseById(db, "mi-lic"))?.badgeKeys).toBe("cc cc-by");

    await updateLicense(db, "mi-lic", { badgeKeys: "copyright" });
    expect((await getLicenseById(db, "mi-lic"))?.badgeKeys).toBe("copyright");

    // An empty value clears the keys: the image / derived badge takes over.
    await updateLicense(db, "mi-lic", { badgeKeys: "" });
    expect((await getLicenseById(db, "mi-lic"))?.badgeKeys).toBe("");

    expect((await listLicenses(db)).map((l) => l.badgeKeys)).toEqual([""]);

    await deleteLicense(db, "mi-lic");
    expect(await listLicenses(db)).toHaveLength(0);
  });
});
