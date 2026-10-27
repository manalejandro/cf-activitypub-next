import { DurableObject } from "cloudflare:workers";
import { countHit } from "@/lib/rate-limit";

/**
 * Atomic fixed-window rate counter.
 *
 * The KV-based `checkRateLimit` is a get→put pair: N parallel requests all
 * read the same count and all pass, so a burst can blow through any limit
 * (the weakness behind the login/registration throttles). Credential-sensitive
 * surfaces — login, the OAuth consent form, registration, media uploads and
 * WebSocket upgrades — count here instead: one Durable Object per rate-limit
 * key, every hit a single storage read-modify-write, serialized by the DO's
 * single-threaded input guarantee.
 *
 * Wire-up: `[[durable_objects]] class_name = "RateLimitDO"` + a `RATE_LIMIT`
 * binding in wrangler.toml (plus its migration entry). Without the binding,
 * `atomicRateLimit` (lib/rate-limit.ts) falls back to the KV counter, so the
 * code is deployable before the configuration lands.
 */
export class RateLimitDO extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Reset wipes the counter after a legitimate success (a verified login
    // must stop counting toward the lockout). The DO holds only this key's
    // window entries, so clearing storage is exactly "reset this key".
    if (url.pathname === "/reset" && request.method === "POST") {
      const keys = await this.ctx.storage.list<string>();
      const names = [...keys.keys()];
      if (names.length > 0) await this.ctx.storage.delete(names);
      return jsonResponse({ ok: true });
    }
    if (url.pathname !== "/hit" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    let max = 0;
    let windowSeconds = 60;
    try {
      const body = (await request.json()) as { max?: number; windowSeconds?: number };
      max = Math.floor(Number(body.max));
      windowSeconds = Math.max(1, Math.floor(Number(body.windowSeconds)) || 60);
    } catch {
      return jsonResponse({ error: "Invalid body" }, 400);
    }
    if (!Number.isFinite(max) || max < 1) return jsonResponse({ error: "Invalid max" }, 400);

    const decision = await countHit(this.ctx.storage, max, windowSeconds, Math.floor(Date.now() / 1000));
    return jsonResponse(decision);
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
