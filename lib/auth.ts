/**
 * Auth helpers — Bearer token extraction and validation.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { env } from "cloudflare:workers";
import { getTokenByAccessToken, getActorById } from "@/lib/db";
import type { LocalActor } from "@/lib/types";

export async function getAuthenticatedActor(
  request: Request,
  db: D1Database,
  requiredScope?: "push"
): Promise<LocalActor | null> {
  const token = extractBearerToken(request);
  if (!token) return null;

  const tokenRow = await getTokenByAccessToken(db, token);
  if (!tokenRow) return null;

  // Check expiration
  if (tokenRow.expiresAt && new Date(tokenRow.expiresAt) < new Date()) return null;

  if (!tokenRow.actorId) return null;
  const actor = await getActorById(db, tokenRow.actorId);
  if (!actor) return null;

  // Suspended accounts cannot authenticate (Guardian / admin suspension).
  if (actor.suspended) return null;

  // Memorialized accounts cannot log in either (Mastodon's
  // `User#active_for_authentication?`): the account is preserved in memoriam.
  if (actor.memorial) return null;

  // Local accounts must confirm their email and be approved before any API
  // access. Registration issues a token before confirmation (Mastodon
  // behaviour), so this is what keeps an unconfirmed account unusable.
  if (actor.isLocal && (!actor.emailVerified || actor.approved === false)) return null;

  // OAuth scope enforcement: read-only tokens must not mutate state. The web
  // session token is always issued with the full "read write follow push"
  // scope, so this only affects third-party clients that asked for `read`.
  const method = request.method.toUpperCase();
  const mutating = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  if (mutating && !scopesAllow(tokenRow.scope, "write")) return null;
  // Reads require the read scope too: a write-only token must not be able to
  // fetch the account's conversations, notifications, timelines, etc.
  if (!mutating && !scopesAllow(tokenRow.scope, "read")) return null;
  // A write-only posting client must not hijack the account's push endpoint.
  if (requiredScope && !scopesAllow(tokenRow.scope, requiredScope)) return null;

  // Throttled last-access tracking (at most one write per actor per 6 hours).
  // The column feeds the account-expiration clock (months of granularity,
  // warnings 7 days out) and the suggestions' "active locals" pool — a
  // 6-hour-old stamp changes nothing observable, and the UPDATE is gated in
  // SQL so a fresh actor costs zero written rows on every authenticated
  // request.
  try {
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const updated = await db
      .prepare(
        "UPDATE actors SET last_active_at = ? WHERE id = ? AND (last_active_at IS NULL OR last_active_at < ?)"
      )
      .bind(now, tokenRow.actorId, cutoff)
      .run();
    // The account is back: drop the account-expiration warnings so a future
    // inactivity window warns again from scratch (markers are keyed per actor).
    if ((updated.meta?.changes ?? 0) > 0 && env.KV) {
      await Promise.all([
        env.KV.delete(`expiry:warn:7:${tokenRow.actorId}`).catch(() => {}),
        env.KV.delete(`expiry:warn:1:${tokenRow.actorId}`).catch(() => {}),
      ]);
    }
  } catch { /* last_active_at column may be missing pre-migration */ }

  return actor;
}

/**
 * Mastodon OAuth scope semantics: `write` also grants follow actions.
 * A token without a scope string (legacy rows) is treated as full access.
 */
export function scopesAllow(
  scope: string | null | undefined,
  required: "read" | "write" | "follow" | "push"
): boolean {
  // Legacy rows predate the scope column (NULL) and keep full access; an empty
  // string is a real (useless) scope and must not be treated as full access.
  if (scope === null || scope === undefined) return true;
  const parts = scope.split(/[\s,]+/).filter(Boolean);
  if (parts.includes(required)) return true;
  if (required === "follow" && parts.includes("write")) return true;
  return false;
}

export function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }

  const cookie = request.headers.get("Cookie");
  if (cookie) {
    const match = cookie.match(/(?:^|;\s*)auth_token=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }

  return null;
}

export function setAuthCookie(token: string): string {
  // HttpOnly: the web session must not be readable by page JavaScript (an XSS
  // in rendered remote content used to be one `document.cookie` away from a
  // full 30-day bearer). Client calls that cannot ride the cookie (WebSocket
  // query params) use the separate localStorage copy — see lib/client-api.ts.
  return `auth_token=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${3600 * 24 * 30}`;
}

export function clearAuthCookie(): string {
  return `auth_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function requireAuth(actor: LocalActor | null): Response | null {
  if (!actor) {
    return new Response(
      JSON.stringify({ error: "The access token is invalid" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }
  return null;
}

// Password hashing: PBKDF2-SHA256 (Web Crypto API).
//
// Stored shape: `pbkdf2:<iterations>:<saltHex>:<hashHex>`. Hashes created
// before the iteration count was encoded have three segments
// (`pbkdf2:<saltHex>:<hashHex>`) and are read as LEGACY_PBKDF2_ITERATIONS;
// a successful sign-in with one rehashes it transparently to the current cost
// (see `needsPasswordRehash`), so existing accounts migrate as they log in.
export const PBKDF2_ITERATIONS = 600_000; // OWASP recommendation for PBKDF2-HMAC-SHA256
const LEGACY_PBKDF2_ITERATIONS = 100_000;

async function pbkdf2Hex(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  // Copy into a fresh ArrayBuffer: the current workers types only accept a
  // BufferSource backed by a plain ArrayBuffer, and callers hand in views of
  // either flavour (getRandomValues, Uint8Array.from).
  const saltBuffer = new Uint8Array(salt).buffer as ArrayBuffer;
  const passwordBuffer = new Uint8Array(new TextEncoder().encode(password)).buffer as ArrayBuffer;
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    passwordBuffer,
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBuffer, iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hashHex = await pbkdf2Hex(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2:${PBKDF2_ITERATIONS}:${toHex(salt)}:${hashHex}`;
}

/** Parse a stored hash into its parts; null when the shape is unusable. */
function parsePasswordHash(stored: string): { iterations: number; saltHex: string; hashHex: string } | null {
  const parts = stored.split(":");
  if (parts[0] !== "pbkdf2") return null;
  if (parts.length === 4) {
    const iterations = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(iterations) || iterations < 1) return null;
    return { iterations, saltHex: parts[2], hashHex: parts[3] };
  }
  if (parts.length === 3) {
    return { iterations: LEGACY_PBKDF2_ITERATIONS, saltHex: parts[1], hashHex: parts[2] };
  }
  return null;
}

/** Whether a stored hash predates the current cost and should be rehashed on next login. */
export function needsPasswordRehash(stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parsed = parsePasswordHash(stored);
  return parsed ? parsed.iterations < PBKDF2_ITERATIONS : false;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  if (!/^[0-9a-f]+$/i.test(parsed.saltHex) || parsed.saltHex.length % 2 !== 0) return false;
  if (!/^[0-9a-f]+$/i.test(parsed.hashHex)) return false;

  const salt = Uint8Array.from(parsed.saltHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const computedHex = await pbkdf2Hex(password, salt, parsed.iterations);
  return timingSafeEqualStr(computedHex, parsed.hashHex.toLowerCase());
}

export function generateSecureToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Equality check for secrets that does not leak where the first mismatch is:
 * a plain `===` short-circuits on the first differing byte, which lets a
 * remote attacker measure their way through a token character by character.
 * Lengths must match (a secret's length is not itself a secret).
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
