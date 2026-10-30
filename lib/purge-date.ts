/**
 * When a suspended account is purged: one month after the suspension, the same
 * rule the expiration sweep applies (`SUSPENDED_PURGE_MONTHS`).
 *
 * Deliberately free of DB imports so the admin tables can compute the date in
 * the browser (lib/dates is pure — it only converts shapes).
 */

import { parseDbDate } from "@/lib/dates";

export const SUSPENDED_PURGE_MONTHS = 1;

export function purgeDateFrom(suspendedAt: string): string {
  // parseDbDate, not a bare `new Date(...)`: legacy backfills left
  // `suspended_at` rows in the DB shape ("YYYY-MM-DD HH:MM:SS"), which JS
  // reads as LOCAL time — the purge column of the admin table showed a
  // different instant than the suspension column of the same row (the server
  // purges in pure UTC).
  const date = parseDbDate(suspendedAt) ?? new Date(suspendedAt);
  date.setMonth(date.getMonth() + SUSPENDED_PURGE_MONTHS);
  return date.toISOString();
}
