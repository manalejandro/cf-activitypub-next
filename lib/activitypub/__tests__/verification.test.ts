// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Database, D1Result } from "@cloudflare/workers-types";

const federation = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  validateOutboundUrl: vi.fn(() => ({ valid: true })),
}));

vi.mock("@/lib/activitypub/federation", () => federation);

import { verifyAccountFields } from "@/lib/activitypub/verification";

class D1Adapter {
  private sql = new DatabaseSync(":memory:");

  constructor(schemaSql: string) {
    this.sql.exec("PRAGMA foreign_keys = ON");
    this.sql.exec(schemaSql);
  }

  async batch(statements: { run(): Promise<D1Result> }[]): Promise<D1Result[]> {
    const results: D1Result[] = [];
    for (const s of statements) results.push(await s.run());
    return results;
  }

  prepare(query: string) {
    const stmt = this.sql.prepare(query);
    return {
      bind(...params: unknown[]) {
        const bound = params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p));
        return {
          async all<T = unknown>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }> {
            return { results: stmt.all(...(bound as never[])) as unknown as T[], success: true, meta: {} };
          },
          async first<T = unknown>(): Promise<T | null> {
            return (stmt.get(...(bound as never[])) as unknown as T | undefined) ?? null;
          },
          async run(): Promise<D1Result> {
            const info = stmt.run(...(bound as never[]));
            return { success: true, meta: { changes: info.changes }, results: [] } as unknown as D1Result<unknown>;
          },
        };
      },
    };
  }
}

const ACTOR = "https://remote.example/users/fan";

let db: D1Database;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  federation.safeFetch.mockReset();
  federation.validateOutboundUrl.mockReset();
  federation.validateOutboundUrl.mockReturnValue({ valid: true });
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  const schema = readFileSync(join(process.cwd(), "lib/db/schema.sql"), "utf8");
  db = new D1Adapter(schema) as unknown as D1Database;

  await db.prepare(
    `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
     VALUES (?, 'fan', 'remote.example', 'k', NULL, 0)`
  ).bind(ACTOR).run();

  const insertField = db.prepare(
    "INSERT INTO actor_fields (id, actor_id, name, value, position) VALUES (?,?,?,?,?)"
  );
  await insertField.bind("f-http", ACTOR, "Lattes", '<a href="http://buscatextual.cnpq.br/x?id=1">cv</a>', 0).run();
  await insertField.bind("f-https", ACTOR, "Blog", '<a href="https://blog.example/">blog</a>', 1).run();
});

describe("verifyAccountFields", () => {
  it("skips plain-http field URLs without fetching or logging a blocked request", async () => {
    federation.safeFetch.mockResolvedValue(null);

    const result = await verifyAccountFields(db, ACTOR, "local.example");
    expect(result.verifiedFields).toBe(0);

    // Only the https field is fetched; the http one is dropped quietly.
    expect(federation.safeFetch).toHaveBeenCalledTimes(1);
    const fetched = String(federation.safeFetch.mock.calls[0][0]);
    expect(fetched).toBe("https://blog.example/");
    expect(federation.validateOutboundUrl).not.toHaveBeenCalledWith("http://buscatextual.cnpq.br/x?id=1");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not fetch anything when every field is plain http", async () => {
    await db.prepare("DELETE FROM actor_fields WHERE id = 'f-https'").bind().run();
    const result = await verifyAccountFields(db, ACTOR, "local.example");
    expect(result.verifiedFields).toBe(0);
    expect(federation.safeFetch).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
