/**
 * Admin endpoint authentication.
 *
 * Admin routes are authorized by the authenticated actor's role stored in the
 * database (`admin` or `moderator`). A shared `ADMIN_TOKEN` secret remains
 * supported as a fallback for operator tooling that cannot log in as a user —
 * when it is configured, presenting it also grants access.
 */

import { getAuthenticatedActor } from "@/lib/auth";

export interface AdminAuthEnv {
  ADMIN_TOKEN?: string;
  DB: D1Database;
}

/**
 * Resolved admin role for the request: `admin` (or the shared ADMIN_TOKEN, which
 * implies full admin), `moderator`, or null when unauthorized.
 */
export async function getAdminRole(request: Request, env: AdminAuthEnv): Promise<"admin" | "moderator" | null> {
  // Fallback: shared operator secret. When set, a matching bearer token grants
  // full admin access regardless of the actor's role.
  const expected = env.ADMIN_TOKEN;
  if (expected) {
    const auth = request.headers.get("Authorization") ?? "";
    if (auth.startsWith("Bearer ")) {
      const token = auth.slice(7).trim();
      if (token && token.length === expected.length && token === expected) return "admin";
    }
  }

  // Primary path: the authenticated user must hold an admin/moderator role.
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return null;
  if (actor.role === "admin") return "admin";
  if (actor.role === "moderator") return "moderator";

  try {
    const row = await env.DB
      .prepare("SELECT role FROM actors WHERE id = ?")
      .bind(actor.id)
      .first<{ role: string }>();
    if (row?.role === "admin") return "admin";
    if (row?.role === "moderator") return "moderator";
  } catch {
    // Missing role column — treat as non-admin.
  }

  return null;
}

export async function requireAdmin(request: Request, env: AdminAuthEnv): Promise<boolean> {
  return (await getAdminRole(request, env)) !== null;
}

/**
 * Full administrator only. Moderators cannot manage roles, instance settings,
 * federation rules or wipe audit logs — those change who controls the instance.
 */
export async function requireFullAdmin(request: Request, env: AdminAuthEnv): Promise<boolean> {
  return (await getAdminRole(request, env)) === "admin";
}