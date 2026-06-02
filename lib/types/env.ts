export interface CloudflareEnv {
  DB: D1Database;
  KV: KVNamespace;
  R2: R2Bucket;
  DELIVERY_QUEUE: Queue;
  ASSETS: Fetcher;
  TIMELINE_STREAM: DurableObjectNamespace;
  /** Cloudflare Email Workers binding for sending emails. */
  EMAIL: SendEmail;
  INSTANCE_TITLE: string;
  INSTANCE_DESCRIPTION: string;
  INSTANCE_VERSION: string;
  INSTANCE_URL: string;
  NODE_ENV: string;
  /** Cloudflare Turnstile secret key — set via: wrangler secret put TURNSTILE_SECRET */
  TURNSTILE_SECRET: string;
  /** Cloudflare Turnstile public site key */
  TURNSTILE_SITE_KEY: string;
  /** Sender email address — must be on a domain with Email Routing enabled */
  FROM_EMAIL: string;
}

declare global {
  // Augment Next.js request with Cloudflare context
  interface CloudflareContext {
    env: CloudflareEnv;
    ctx: ExecutionContext;
  }
}
