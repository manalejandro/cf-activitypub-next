import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import vinext from "vinext";
import { defineConfig, type Plugin } from "vite";
import { loadDotenv } from "vinext/internal/config/dotenv";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const EMITTED_CONFIG = path.join(ROOT, "dist", "server", "wrangler.json");
const ENV_EXAMPLE = path.join(ROOT, ".env.example");

/**
 * The variables the app reads, from `.env.example` — the single reference of
 * every environment variable and its default (`npm run check:env` keeps it
 * complete). Only these are considered when merging the environment into the
 * emitted config: a build environment also carries `PATH`, `CLOUDFLARE_*`, CI
 * tokens and a lot more, and none of that may be uploaded.
 */
function documentedVars(): Set<string> {
  if (!fs.existsSync(ENV_EXAMPLE)) return new Set();
  return new Set(
    fs
      .readFileSync(ENV_EXAMPLE, "utf8")
      .split("\n")
      .map((line) => line.replace(/^#\s*/, "").trim())
      .filter((line) => line.includes("="))
      .map((line) => line.split("=")[0].trim())
  );
}

/** Names that must never land in the config in plaintext. */
const SECRET_NAME = /(^|_)(SECRET|TOKEN|PRIVATE_KEY|API_KEY|PASSWORD)(_|$)/;
const EXTRA_SECRETS = new Set(["CALLS_TURN_KEY_ID"]);

/**
 * Upload `.env` at deploy time.
 *
 * `wrangler deploy` uploads the `vars` of the config it is handed, and the
 * Cloudflare Vite plugin only fills the emitted `dist/server/wrangler.json`
 * with `.env`/`process.env` values for names `wrangler.toml` does **not**
 * already define — so a `.env` entry could never override a `[vars]` one
 * (`GRAPH_MAX_NODES=777` in `.env` deployed as the `1000` of wrangler.toml).
 * This plugin merges `.env` into the emitted config at the end of the build,
 * with the same precedence `vinext-cloudflare deploy` uses (`loadDotenv`:
 * `process.env` > `.env.<mode>.local` > `.env.local` > `.env.<mode>` > `.env`),
 * so `npm run deploy` honours the file.
 *
 * Secrets are never copied into the config (they would be uploaded in
 * plaintext): `*_SECRET`/`*_TOKEN`/`*_PRIVATE_KEY`/`*_API_KEY`/`*_PASSWORD` and
 * `CALLS_TURN_KEY_ID` are skipped with a warning — set those with
 * `wrangler secret put`.
 */
function dotenvIntoWorkerVars(): Plugin {
  return {
    name: "dotenv-into-worker-vars",
    apply: "build",
    enforce: "post",
    // `buildApp` (order:post) runs ONCE after every environment's closeBundle —
    // unlike closeBundle, which fires per environment and can run before the
    // Cloudflare plugin has emitted `dist/server/wrangler.json` (or never run
    // at all on an interrupted build). Merging here means the config always
    // exists when we read it, the merge happens exactly once, and a build that
    // never got this far ships nothing (the emit below fails loudly instead of
    // silently leaving `vars` empty — which would deploy the worker without
    // INSTANCE_URL and rebuild every actor IRI on http://localhost:3000).
    buildApp: {
      order: "post",
      async handler() {
        if (!fs.existsSync(EMITTED_CONFIG)) {
          this.error(
            `[deploy] ${EMITTED_CONFIG} was not emitted — refusing to merge .env into a missing worker config.`
          );
          return;
        }
        loadDotenv({ root: ROOT, mode: "production" });
        const documented = documentedVars();
        const config = JSON.parse(fs.readFileSync(EMITTED_CONFIG, "utf8")) as {
          vars?: Record<string, string>;
        };
        config.vars ??= {};
        const applied: string[] = [];
        const skipped: string[] = [];
        for (const key of documented) {
          const value = process.env[key];
          if (typeof value !== "string" || value === "") continue;
          if (SECRET_NAME.test(key) || EXTRA_SECRETS.has(key)) {
            skipped.push(key);
            continue;
          }
          if (config.vars[key] !== value) applied.push(key);
          config.vars[key] = value;
        }
        fs.writeFileSync(EMITTED_CONFIG, `${JSON.stringify(config, null, 2)}\n`);

        // Fail the build rather than deploy a worker with no base URL: without
        // INSTANCE_URL, getBaseUrl() falls back to http://localhost:3000 and
        // every federated IRI (actor ids, object urls, feeds) is minted wrong.
        const instanceUrl = config.vars.INSTANCE_URL;
        if (!instanceUrl || /^https?:\/\/localhost/i.test(instanceUrl)) {
          this.error(
            `[deploy] INSTANCE_URL is missing or points at localhost in the emitted config (${instanceUrl ?? "absent"}). ` +
              `Set it in .env before deploying — a worker built without it federates as http://localhost:3000.`
          );
          return;
        }
        if (applied.length > 0) {
          console.log(`[deploy] .env values applied to the worker vars: ${applied.sort().join(", ")}`);
        } else {
          console.log("[deploy] .env merge ran; every documented value already matched the emitted config.");
        }
        if (skipped.length > 0) {
          console.error(
            `[deploy] secrets left out of the config (set them with "wrangler secret put"): ${skipped.sort().join(", ")}`
          );
        }
      },
    },
  };
}

/**
 * vinext replaces the Next.js toolchain: Vite runs development and builds, and
 * the Cloudflare Vite plugin runs the app inside workerd (bindings available in
 * dev, exactly like production). The custom worker entry (`src/worker.ts`,
 * referenced by `main` in wrangler.toml) wraps the vinext handler and adds the
 * Durable Objects, queue consumers, cron and the media/streaming interceptions.
 */
export default defineConfig({
  // Keep the old `next dev`/`wrangler dev` port (wrangler.toml [dev]).
  server: { port: 3000 },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  plugins: [
    vinext(),
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
    dotenvIntoWorkerVars(),
  ],
});
