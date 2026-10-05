/// <reference types="@cloudflare/vitest-plugin/types" />

import type { CloudflareEnv } from "@/lib/types/env";

declare global {
  namespace Cloudflare {
    // Bindings available to `env` (cloudflare:test / cloudflare:workers) inside
    // the Workers test project. The base comes from wrangler.toml; TEST_SCHEMA
    // is injected by vitest.config.mts (lib/db/schema.sql split into single
    // statements).
    interface Env extends CloudflareEnv {
      TEST_SCHEMA: string[];
    }
  }
}
