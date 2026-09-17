/**
 * Guard shared by every admin account action (suspend, silence, approve,
 * delete, reject, demote…): a reserved actor's state is immutable, nobody can
 * act on their own account through the admin API, acting on an administrator
 * needs a full admin, and the last usable administrator can never be left
 * without access (the reserved Guardian account has no credentials and does
 * not count).
 */

import { json } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getAdminRole } from "@/lib/admin-auth";
import { countUsableAdmins } from "@/lib/db";
import type { LocalActor } from "@/lib/types";

interface GuardEnv {
  DB: D1Database;
}

export interface AccountGuardOptions {
  /** Set when the action removes access entirely (delete/reject/suspend). */
  removesAccess?: boolean;
}

/**
 * Returns an error Response when the action must be refused, or null when it
 * may proceed. The caller has already passed `requireAdmin`/`requireFullAdmin`.
 */
export async function accountActionGuard(
  request: Request,
  env: GuardEnv,
  target: Pick<LocalActor, "id" | "role" | "reserved">,
  opts: AccountGuardOptions = {}
): Promise<globalThis.Response | null> {
  if (target.reserved) {
    return json({ error: "The instance actor cannot be modified" }, 422);
  }

  const role = await getAdminRole(request, env as never);
  const caller = await getAuthenticatedActor(request, env.DB);
  if (caller && caller.id === target.id) {
    return json({ error: "You cannot perform this action on your own account" }, 422);
  }

  if (target.role === "admin") {
    if (role !== "admin") {
      return json({ error: "Administrator role required" }, 403);
    }
    if (opts.removesAccess && (await countUsableAdmins(env.DB, target.id)) === 0) {
      return json({ error: "Cannot remove the last administrator's access" }, 422);
    }
  }

  return null;
}
