export interface CloudflareEnv {
  DB: D1Database;
  KV: KVNamespace;
  R2: R2Bucket;
  DELIVERY_QUEUE: Queue;
  ASSETS: Fetcher;
  TIMELINE_STREAM: DurableObjectNamespace;
  CALL_SIGNALING: DurableObjectNamespace;
  /** The Guardian's Cloudflare Agent (Agents SDK, `AIChatAgent`). */
  GuardianAgent: DurableObjectNamespace;
  /**
   * Atomic fixed-window rate limiter (lib/rate-limit-do.ts). Optional:
   * `atomicRateLimit` falls back to the KV counter when the binding is not
   * configured in wrangler.toml.
   */
  RATE_LIMIT?: DurableObjectNamespace;
  /** Cloudflare Workers AI binding for image auto-description */
  AI: Ai;
  /** Cloudflare Email Workers binding for sending emails. */
  EMAIL: SendEmail;
  INSTANCE_TITLE: string;
  INSTANCE_DESCRIPTION: string;
  INSTANCE_VERSION: string;
  INSTANCE_URL: string;
  NODE_ENV: string;
/** Optional: Cloudflare Calls Turn Key ID for TURN credential generation */
CALLS_TURN_KEY_ID?: string;
/** Optional: Cloudflare API token with calls:turn permission for TURN credential generation */
CALLS_API_TOKEN?: string;
  /** Cloudflare Turnstile secret key — set via: wrangler secret put TURNSTILE_SECRET */
  TURNSTILE_SECRET: string;
  /** Cloudflare Turnstile public site key */
  TURNSTILE_SITE_KEY: string;
  /** Sender email address — must be on a domain with Email Routing enabled */
  FROM_EMAIL: string;
  /** LibreTranslate instance URL (e.g. https://translate.manalejandro.com/translate) */
  LIBRETRANSLATE_URL: string;
  /** Web Push VAPID keys — set via: wrangler secret put VAPID_PRIVATE_KEY */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_EMAIL?: string;
  /** Optional shared secret for admin endpoints — set via: wrangler secret put ADMIN_TOKEN */
  ADMIN_TOKEN?: string;
  /** Optional Cloudflare Vectorize index — semantic memory for AI moderation. */
  VECTORIZE?: VectorizeIndex;
  /** Instance-wide daily AI budget in abstract units; unset/0 = unlimited. */
  AI_DAILY_BUDGET?: string | number;
}

declare global {
  // Augment Next.js request with Cloudflare context
  interface CloudflareContext {
    env: CloudflareEnv;
    ctx: ExecutionContext;
  }
}
