/**
 * Cloudflare context helper — retrieves the bound env from the Next.js request.
 */

import { getCloudflareContext as _getCloudflareContext } from "@opennextjs/cloudflare";
import type { CloudflareEnv } from "./types/env";

export function getCloudflareContext(): { env: CloudflareEnv } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return _getCloudflareContext() as any;
}

export function getBaseUrl(env: CloudflareEnv): string {
  // In production, INSTANCE_URL should be set. Fallback for local dev.
  return (env as unknown as Record<string, string>).INSTANCE_URL ?? "http://localhost:3000";
}

export function getDomain(env: CloudflareEnv): string {
  return new URL(getBaseUrl(env)).hostname;
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
