export interface CloudflareEnv {
  DB: D1Database;
  KV: KVNamespace;
  R2: R2Bucket;
  DELIVERY_QUEUE: Queue;
  ASSETS: Fetcher;
  TIMELINE_STREAM: DurableObjectNamespace;
  CALL_SIGNALING: DurableObjectNamespace;
  INSTANCE_TITLE: string;
  INSTANCE_DESCRIPTION: string;
  INSTANCE_VERSION: string;
  NODE_ENV: string;
  /** Optional: Cloudflare Calls app ID for TURN credential generation */
  CALLS_APP_ID?: string;
  /** Optional: Cloudflare Calls app secret for TURN credential generation */
  CALLS_APP_SECRET?: string;
}

declare global {
  // Augment Next.js request with Cloudflare context
  interface CloudflareContext {
    env: CloudflareEnv;
    ctx: ExecutionContext;
  }
}
