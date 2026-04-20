/**
 * Auth helpers — Bearer token extraction and validation.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { getTokenByAccessToken, getActorById } from "@/lib/db";
import type { LocalActor } from "@/lib/types";

export async function getAuthenticatedActor(
  request: Request,
  db: D1Database
): Promise<LocalActor | null> {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;

  const token = auth.slice(7).trim();
  if (!token) return null;

  const tokenRow = await getTokenByAccessToken(db, token);
  if (!tokenRow) return null;

  // Check expiration
  if (tokenRow.expiresAt && new Date(tokenRow.expiresAt) < new Date()) return null;

  if (!tokenRow.actorId) return null;
  return getActorById(db, tokenRow.actorId);
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

// Simple bcrypt-compatible hashing using PBKDF2 (Web Crypto API)
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const saltHex = Array.from(salt).map((b) => b.toString(16).padStart(2, "0")).join("");
  const hashHex = Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `pbkdf2:${saltHex}:${hashHex}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltHex, hashHex] = stored.split(":");
  if (algo !== "pbkdf2") return false;

  const salt = Uint8Array.from(saltHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const computedHex = Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return computedHex === hashHex;
}

export function generateSecureToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
