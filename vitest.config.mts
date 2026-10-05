import { configDefaults, defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * Two test projects:
 *
 * - `unit`: the jsdom suite (React components, pure logic) with the in-memory
 *   `node:sqlite` D1 shim.
 * - `workers`: `test/**` inside workerd with the real bindings from
 *   wrangler.toml (D1, KV, R2, queues, DOs…) through Miniflare. workerd has no
 *   DOM and no `node:sqlite`, so the projects stay separate.
 *
 * `main` is overridden because production's `src/worker.ts` imports the
 * OpenNext build artifact (`.open-next/worker.js`), which only exists after a
 * build; `test/worker.ts` re-exports the Durable Object classes instead. The
 * assets directory is overridden too, so tests run on a fresh clone without a
 * build. `lib/db/schema.sql` is split with Wrangler's own SQL splitter and
 * injected as the `TEST_SCHEMA` binding for `test/helpers/db.ts`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": root,
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "jsdom",
          setupFiles: ["./vitest.setup.ts"],
          include: ["**/*.test.{ts,tsx}", "**/__tests__/**/*.test.{ts,tsx}"],
          exclude: [...configDefaults.exclude, "**/*.workers.test.ts"],
          globals: true,
        },
      },
      {
        extends: true,
        plugins: [
          cloudflareTest(async () => {
            const [schema] = await readD1Migrations({
              projectPath: root,
              migrationsDir: "lib/db",
              migrationsPattern: "lib/db/schema.sql",
            });
            return {
              wrangler: { configPath: "./wrangler.toml" },
              main: "./test/worker.ts",
              miniflare: {
                assets: { directory: "test/assets", binding: "ASSETS" },
                bindings: { TEST_SCHEMA: schema.queries },
              },
            };
          }),
        ],
        test: {
          name: "workers",
          include: ["test/**/*.workers.test.ts"],
          globals: true,
          // Miniflare workers share the local runtime; running the few
          // integration files serially avoids a teardown race where Vitest
          // cannot close the pool (process hangs after the tests pass).
          fileParallelism: false,
        },
      },
    ],
  },
});
