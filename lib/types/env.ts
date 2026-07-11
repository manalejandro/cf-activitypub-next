export interface CloudflareEnv {
  DB: D1Database;
  KV: KVNamespace;
  R2: R2Bucket;
  DELIVERY_QUEUE: Queue;
  ASSETS: Fetcher;
  TIMELINE_STREAM: DurableObjectNamespace;
  CALL_SIGNALING: DurableObjectNamespace;
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
}

declare global {
  // Augment Next.js request with Cloudflare context
  interface CloudflareContext {
    env: CloudflareEnv;
    ctx: ExecutionContext;
  }
}
