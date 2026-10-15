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
 * `main` is overridden because production's `src/worker.ts` imports the vinext
 * app handler, which only exists after a Vite build; `test/worker.ts`
 * re-exports the Durable Object classes instead. The
 * assets directory is overridden too, so tests run on a fresh clone without a
 * build. `lib/db/schema.sql` is split with Wrangler's own SQL splitter and
 * injected as the `TEST_SCHEMA` binding for `test/helpers/db.ts`.
 */
/**
 * The app has no `next` dependency: the vinext Vite plugin resolves the public
 * `next/*` modules to its own shims (`vinext/dist/shims/public-shim-map.json`).
 * The test projects run without that plugin, so the same mapping is applied
 * here — otherwise every route handler import fails to resolve.
 */
const NEXT_SHIMS: Record<string, string> = {
  "next/link": "vinext/shims/link",
  "next/head": "vinext/shims/head",
  "next/router": "vinext/shims/router",
  "next/compat/router": "vinext/shims/compat-router",
  "next/image": "vinext/shims/image",
  "next/legacy/image": "vinext/shims/legacy-image",
  "next/dynamic": "vinext/shims/dynamic",
  "next/app": "vinext/shims/app",
  "next/document": "vinext/shims/document",
  "next/config": "vinext/shims/config",
  "next/script": "vinext/shims/script",
  "next/server": "vinext/shims/server",
  "next/navigation": "vinext/shims/navigation",
  "next/headers": "vinext/shims/headers",
  "next/font/google": "vinext/shims/font-google",
  "next/font/local": "vinext/shims/font-local",
  "next/cache": "vinext/shims/cache",
  "next/form": "vinext/shims/form",
  "next/og": "vinext/shims/og",
  "next/web-vitals": "vinext/shims/web-vitals",
  "next/error": "vinext/shims/error",
  "next/constants": "vinext/shims/constants",
};

export default defineConfig({
  resolve: {
    alias: {
      "@": root,
      ...NEXT_SHIMS,
    },
  },
  test: {
    projects: [
      {
        extends: true,
        plugins: [
          {
            // The real `cloudflare:workers` only exists inside workerd: map the
            // specifier to a stub for the jsdom project (tests override `env`
            // with vi.mock). A resolveId plugin wins over Vite's externalization,
            // which plain resolve/test aliases do not.
            name: "stub-cloudflare-workers",
            enforce: "pre",
            resolveId(source: string) {
              if (source === "cloudflare:workers") {
                return fileURLToPath(new URL("./test/stubs/cloudflare-workers.ts", import.meta.url));
              }
              return null;
            },
          },
        ],
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
