/**
 * What anonymous visitors may see of the public timelines.
 *
 * Stored as the `anonymous_timelines` instance setting (admin → Settings),
 * exposed by `/api/v1/instance` so the API, the streaming worker and the UI all
 * enforce the same rule:
 *  - `public` (default): the public/federated timeline only;
 *  - `public_local`: the public and the local timelines;
 *  - `none`: neither — the timelines require a session.
 *
 * Deliberately free of DB imports so client components can use it.
 */

export type AnonymousTimelineAccess = "public" | "public_local" | "none";

export const ANONYMOUS_TIMELINES_KEY = "anonymous_timelines";

export function normalizeAnonymousTimelineAccess(value: string | null | undefined): AnonymousTimelineAccess {
  return value === "public_local" || value === "none" ? value : "public";
}

/** Whether a request without a session may read the public timeline (`local` = local view). */
export function anonymousTimelineAllowed(access: AnonymousTimelineAccess, local: boolean): boolean {
  if (access === "none") return false;
  return local ? access === "public_local" : true;
}
