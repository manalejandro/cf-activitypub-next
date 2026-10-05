import { env } from "cloudflare:workers";

/**
 * Route handlers resolve their bindings through OpenNext's global context
 * (`getCloudflareContext()` reads `globalThis[Symbol.for("__cloudflare-context__")]`).
 * Production sets it in the worker entry; tests install the test Worker's
 * bindings on the same symbol so a handler can be called directly with real
 * D1/KV/R2. Call this before invoking a handler that reads `env`.
 */
export function installTestContext(): void {
  (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("__cloudflare-context__")] = { env };
}
