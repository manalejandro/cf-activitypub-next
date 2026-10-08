/**
 * Response helpers and env-derived utilities shared by the API routes.
 *
 * Bindings are read directly with `import { env } from "cloudflare:workers"`
 * (typed through `Cloudflare.Env`, see worker-configuration.d.ts) — there is no
 * request-context indirection anymore.
 */

import { env } from "cloudflare:workers";
import type { CloudflareEnv } from "./types/env";

export function getBaseUrl(env: CloudflareEnv): string {
  // In production, INSTANCE_URL should be set. Fallback for local dev.
  return (env as unknown as Record<string, string>).INSTANCE_URL ?? "http://localhost:3000";
}

export function getDomain(env: CloudflareEnv): string {
  return new URL(getBaseUrl(env)).hostname;
}

/**
 * Instance brand name (INSTANCE_TITLE) for code that runs inside a request but
 * has no env at hand (serializers). Falls back to the project default outside a
 * Worker context (unit tests, build).
 */
export function getInstanceTitle(): string {
  try {
    if (env.INSTANCE_TITLE) return env.INSTANCE_TITLE;
  } catch { /* no Cloudflare env (unit tests, build) */ }
  return "CF ActivityPub";
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function activityJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": 'application/activity+json; charset=utf-8',
    },
  });
}

export function notFound(message = "Not found"): Response {
  return json({ error: message }, 404);
}

export function badRequest(message = "Bad request"): Response {
  return json({ error: message }, 422);
}

export function unauthorized(): Response {
  return json({ error: "The access token is invalid" }, 401);
}

// ─────────────────────────────────────────
// Rate limiting helper (KV-backed)
// ─────────────────────────────────────────

type KVNamespace = { get(key: string): Promise<string | null>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> };

export async function checkRateLimit(
  kv: KVNamespace,
  key: string,
  maxAttempts: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number }> {
  const now = Math.floor(Date.now() / 1000);
  const windowKey = `ratelimit:${key}:${Math.floor(now / windowSeconds)}`;
  const count = await kv.get(windowKey);
  const current = count ? parseInt(count, 10) : 0;
  if (current >= maxAttempts) {
    return { allowed: false, remaining: 0 };
  }
  await kv.put(windowKey, String(current + 1), { expirationTtl: windowSeconds });
  return { allowed: true, remaining: maxAttempts - current - 1 };
}
