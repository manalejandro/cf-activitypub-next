import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import vinext from "vinext";
import { defineConfig } from "vite";

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
  ],
});
