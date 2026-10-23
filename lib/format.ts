/** Human sizes and counters shared by the admin panels and the status page. */

/**
 * Parse a timestamp the way the database stores it.
 *
 * SQLite's `datetime('now')` writes `YYYY-MM-DD HH:MM:SS` in **UTC with no zone
 * marker**, and `new Date()` reads that shape as *local* time: the audit log
 * showed every action two hours in the past in Madrid (a suspension applied
 * "now" looked like an old entry). ISO values and plain dates pass through.
 */
export function parseDbDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const iso = value.includes("T") || !value.includes(":") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** power).toFixed(power === 0 ? 0 : 1)} ${units[power]}`;
}

export function formatCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString() : "0";
}
