/**
 * When a suspended account is purged: one month after the suspension, the same
 * rule the expiration sweep applies (`SUSPENDED_PURGE_MONTHS`).
 *
 * Deliberately free of DB imports so the admin tables can compute the date in
 * the browser.
 */

export const SUSPENDED_PURGE_MONTHS = 1;

export function purgeDateFrom(suspendedAt: string): string {
  const date = new Date(suspendedAt);
  date.setMonth(date.getMonth() + SUSPENDED_PURGE_MONTHS);
  return date.toISOString();
}
