/**
 * Query string for the notifications feed of one tab.
 *
 * The type filter must reach the server query (`getNotifications` applies
 * `types[]` in SQL): filtering the fetched page in the route returned short
 * pages and stopped pagination — the mentions tab only held the mentions that
 * happened to fall inside the first page.
 */

export type NotificationsTab = "all" | "mentions" | "filtered";

// Mastodon delivers direct messages as mention notifications, so its Mentions
// tab includes them; ours carry their own `direct`/`encrypted` types and must
// join the tab to keep the same experience (they also live in /messages).
export const MENTIONS_TAB_TYPES = ["mention", "direct", "encrypted"] as const;

export function notificationsQuery(tab: NotificationsTab, limit: number, maxId?: string): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (tab === "mentions") for (const type of MENTIONS_TAB_TYPES) params.append("types[]", type);
  // Limited-account policy: the Filtered tab asks for the filtered ones only;
  // every other tab excludes them.
  if (tab === "filtered") params.set("filtered", "true");
  if (maxId) params.set("max_id", maxId);
  return `/api/v1/notifications?${params}`;
}
