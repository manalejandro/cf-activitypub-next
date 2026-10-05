import { env } from "cloudflare:workers";

let applied = false;

/**
 * Apply lib/db/schema.sql to the test D1 database. The statements are split by
 * Wrangler's SQL splitter in the Vitest config and handed over as the
 * `TEST_SCHEMA` binding. Storage is isolated per test file, so every workers
 * test file that touches the DB calls this once (module state does not survive
 * across files).
 */
export async function applyTestSchema(): Promise<void> {
  if (applied) return;
  for (const query of env.TEST_SCHEMA) {
    await env.DB.prepare(query).run();
  }
  applied = true;
}

/**
 * Empty every table between tests. Storage is isolated per test **file**, not
 * per test, and the old node:sqlite adapter handed each test a fresh database;
 * `beforeEach(resetTestDatabase)` keeps that guarantee. Every FK is `ON DELETE
 * CASCADE`, so deleting in any order is safe; D1's internal tables (`sqlite_*`,
 * `_cf_*`) are off-limits (SQLITE_AUTH) and skipped.
 */
export async function resetTestDatabase(): Promise<void> {
  const tables = await env.DB
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'"
    )
    .all<{ name: string }>();
  const names = (tables.results ?? []).map(({ name }) => name);
  if (names.length === 0) return;
  await env.DB.batch(names.map((name) => env.DB.prepare(`DELETE FROM "${name}"`)));
}

/** Empty D1, R2 and KV between tests (storage is isolated per file). */
export async function resetTestStorage(): Promise<void> {
  await resetTestDatabase();

  let r2Cursor: string | undefined;
  do {
    const page = await env.R2.list({ cursor: r2Cursor, limit: 1000 });
    if (page.objects.length > 0) await env.R2.delete(page.objects.map((object) => object.key));
    r2Cursor = page.truncated ? page.cursor : undefined;
  } while (r2Cursor);

  let kvCursor: string | undefined;
  do {
    const page = await env.KV.list({ cursor: kvCursor });
    for (const key of page.keys) await env.KV.delete(key.name);
    kvCursor = page.list_complete ? undefined : page.cursor;
  } while (kvCursor);
}
