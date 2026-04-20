export interface CloudflareEnv {
  DB: D1Database;
  KV: KVNamespace;
  R2: R2Bucket;
  DELIVERY_QUEUE: Queue;
  ASSETS: Fetcher;
  INSTANCE_TITLE: string;
  INSTANCE_DESCRIPTION: string;
  INSTANCE_VERSION: string;
  NODE_ENV: string;
}

declare global {
  // Augment Next.js request with Cloudflare context
  interface CloudflareContext {
    env: CloudflareEnv;
    ctx: ExecutionContext;
  }
}
