// Cloudflare Workers global types — sourced from @cloudflare/workers-types
// This file ensures D1Database, KVNamespace, R2Bucket, Queue, etc. are available globally.

/// <reference types="@cloudflare/workers-types" />

import type { CloudflareEnv } from "./lib/types/env";

// `import { env } from "cloudflare:workers"` is typed through Cloudflare.Env:
// extend it with this instance's bindings (lib/types/env.ts) so app code reads
// DB/KV/R2/… without casts. The workers test project adds TEST_SCHEMA on top
// (test/env.d.ts).
declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration merging needs an interface
    interface Env extends CloudflareEnv {}
  }
}
