/**
 * Cloudflare Turnstile server-side verification via the Siteverify API.
 * Docs: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 *
 * Security notes:
 * - Tokens are single-use and expire 300s after generation, so validate on
 *   every request and never trust client-side validation alone.
 * - Only the backend calls Siteverify; the secret must never reach the client.
 * - Hostname/action are checked when expected so a token minted on another
 *   site (or for another flow) is rejected.
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TOKEN_LENGTH = 2048;

export interface TurnstileVerifyResult {
  success: boolean;
  hostname?: string;
  action?: string;
  challengeTs?: string;
  errorCodes?: string[];
}

export interface TurnstileVerifyOptions {
  /** The widget's secret key from the Cloudflare dashboard. */
  secret: string;
  /** Visitor's IP address (best-effort). */
  remoteIp?: string;
  /** Hostname the challenge was expected to be served on. */
  expectedHostname?: string;
  /** Expected widget `action` from the client-side render options. */
  expectedAction?: string;
  /** Abort the Siteverify request after this many ms. */
  timeoutMs?: number;
  /** UUID to retry validation safely (reuse the same value across retries). */
  idempotencyKey?: string;
}

let warnedMissingSecret = false;

/**
 * Enforce the captcha for a user-facing flow. When `TURNSTILE_SECRET` is not
 * configured (local dev, self-host without Turnstile) the check is skipped so
 * auth still works, but that is logged — never treat "no secret" as verified.
 * With a secret configured a missing/invalid token always fails. Callers must
 * reject the request when `success` is false.
 */
export async function enforceTurnstilePolicy(
  options: TurnstileVerifyOptions & { secret: string | undefined | null; token?: string | null }
): Promise<TurnstileVerifyResult & { skipped?: boolean }> {
  if (!options.secret) {
    if (!warnedMissingSecret) {
      warnedMissingSecret = true;
      console.warn("[turnstile] TURNSTILE_SECRET is not configured: captcha checks are disabled");
    }
    return { success: true, skipped: true };
  }
  return verifyTurnstileToken(options.token, options);
}

export async function verifyTurnstileToken(
  token: string | null | undefined,
  options: TurnstileVerifyOptions
): Promise<TurnstileVerifyResult> {
  const fail = (errorCodes: string[]): TurnstileVerifyResult => ({ success: false, errorCodes });

  if (!token || typeof token !== "string") return fail(["missing-input-response"]);
  if (token.length > MAX_TOKEN_LENGTH) return fail(["invalid-input-response"]);

  const params = new URLSearchParams({ secret: options.secret, response: token });
  if (options.remoteIp) params.set("remoteip", options.remoteIp);
  if (options.idempotencyKey) params.set("idempotency_key", options.idempotencyKey);

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Siteverify is idempotent for a given token when the same idempotency_key is
  // reused, so transport/5xx failures can be retried safely. Without a key a
  // retry could race a concurrent validation, so only retry when keyed.
  const attempts = options.idempotencyKey ? 2 : 1;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(SITEVERIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        signal: controller.signal,
      });

      if (!res.ok) {
        // 4xx is a protocol/credentials problem — retrying won't help.
        if (res.status < 500) return fail(["bad-request"]);
        throw new Error(`Siteverify responded ${res.status}`);
      }

      const data = await res.json() as {
        success?: boolean;
        "error-codes"?: string[];
        hostname?: string;
        action?: string;
        challenge_ts?: string;
      };

      if (!data.success) {
        return { success: false, errorCodes: data["error-codes"] ?? [] };
      }

      if (options.expectedHostname && data.hostname !== options.expectedHostname) {
        return fail(["hostname-mismatch"]);
      }
      if (options.expectedAction && data.action !== options.expectedAction) {
        return fail(["action-mismatch"]);
      }

      return {
        success: true,
        hostname: data.hostname,
        action: data.action,
        challengeTs: data.challenge_ts,
      };
    } catch {
      if (attempt === attempts - 1) return fail(["internal-error"]);
    } finally {
      clearTimeout(timer);
    }
  }

  return fail(["internal-error"]);
}