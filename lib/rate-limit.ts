import { checkRateLimit } from "@/lib/cf";

/**
 * Minimal Durable Object namespace surface. Structural on purpose: the
 * ambient binding types (worker-configuration.d.ts) and the ones exported by
 * `@cloudflare/workers-types` drifted apart in a types release, and `env`
 * must satisfy this parameter from every tsconfig. `KVNamespace` is left
 * ambient (no import) for the same reason — lib/cf.ts's checkRateLimit takes
 * the ambient type too.
 */
interface RateLimitNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

interface RateLimitBindings {
  RATE_LIMIT?: RateLimitNamespace;
  KV?: KVNamespace;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  /** Seconds until the fixed window rolls over (only set by the DO path). */
  retryAfter?: number;
}

/** The slice of DO storage the counter needs (matches DurableObjectStorage). */
export interface RateLimitStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown, opts?: { noCache?: boolean; expirationTtl?: number }): Promise<void>;
}

/**
 * Fixed-window counter core, shared with RateLimitDO: increments the current
 * window's count in strongly-consistent DO storage and reports the decision.
 * The entry auto-expires with the window it covers.
 */
export async function countHit(
  storage: RateLimitStorage,
  max: number,
  windowSeconds: number,
  nowSeconds: number
): Promise<RateLimitDecision> {
  const window = Math.floor(nowSeconds / windowSeconds);
  const key = `w:${window}`;
  const count = ((await storage.get<number>(key)) ?? 0) + 1;
  await storage.put(key, count, { noCache: true, expirationTtl: windowSeconds * 2 });
  const allowed = count <= max;
  return {
    allowed,
    remaining: Math.max(0, max - count),
    retryAfter: allowed ? 0 : (window + 1) * windowSeconds - nowSeconds,
  };
}

/**
 * Atomic rate limit for abuse-sensitive surfaces (credential checks,
 * registration, uploads, WebSocket upgrades).
 *
 * Counts in the `RateLimitDO` Durable Object when the binding is configured —
 * strongly consistent, race-free — and degrades to the best-effort KV counter
 * (`checkRateLimit`) when it is not, so the limiter keeps working on instances
 * whose wrangler.toml predates the binding. A DO error also falls back: rate
 * limiting must never become the reason a login fails.
 */
export async function atomicRateLimit(
  bindings: RateLimitBindings,
  key: string,
  maxAttempts: number,
  windowSeconds: number
): Promise<RateLimitDecision> {
  if (bindings.RATE_LIMIT) {
    try {
      const stub = bindings.RATE_LIMIT.get(bindings.RATE_LIMIT.idFromName(key));
      const res = await stub.fetch("https://rate-limit/hit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max: maxAttempts, windowSeconds }),
      });
      if (res.ok) {
        const body = (await res.json()) as RateLimitDecision;
        return {
          allowed: body.allowed !== false,
          remaining: Math.max(0, Number(body.remaining) || 0),
          retryAfter: Number(body.retryAfter) || 0,
        };
      }
    } catch (err) {
      console.warn("[rate-limit] DO unavailable, falling back to KV:", err);
    }
  }
  if (bindings.KV) {
    const { allowed, remaining } = await checkRateLimit(bindings.KV, key, maxAttempts, windowSeconds);
    return { allowed, remaining };
  }
  return { allowed: true, remaining: maxAttempts };
}
