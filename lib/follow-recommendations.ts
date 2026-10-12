/**
 * Instance follow recommendations (Mastodon's `FollowRecommendation`).
 *
 * Mastodon precomputes, once a day, a ranking of which accounts its recently
 * active users follow (`most_followed`) and whose recent posts got the most
 * interactions (`most_interactions`), stores it in
 * `global_follow_recommendations` and serves suggestions from it. That is what
 * keeps the list useful when the local graph is small or the viewer already
 * follows everyone the live pools know.
 *
 * We compute the same ranking into KV (`suggestions:follow_recommendations`):
 * the cron refreshes it daily and `/api/v2/suggestions` uses it as a pool.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { PUBLIC_STATUS_TYPE_SQL } from "@/lib/db";

export const FOLLOW_RECOMMENDATIONS_KEY = "suggestions:follow_recommendations";
/** Entries kept (the suggestions pool takes the top of the list). */
const RECOMMENDATION_LIMIT = 300;
/** Mastodon's window for both signals. */
const RECOMMENDATION_WINDOW_DAYS = 30;
/** `most_interactions` floor: a post needs this much engagement to count. */
const INTERACTION_FLOOR = 3;
/** The ranking outlives a missed cron run but is never served stale for long. */
const RECOMMENDATIONS_TTL_SECONDS = 3 * 86_400;
/** How often the cron recomputes it. */
export const RECOMMENDATIONS_REFRESH_HOURS = 24;

export interface FollowRecommendations {
  ids: string[];
  updatedAt: string;
}

export interface RecommendationsEnv {
  DB: D1Database;
  KV?: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  };
}

/**
 * Recompute the ranking and store it. Returns how many accounts it holds.
 *
 * `most_followed` counts accepted follows made by **recently active** local
 * accounts (an account nobody uses should not shape the recommendations).
 * `most_interactions` sums the engagement of the recent public/unlisted posts
 * of each author. Like Mastodon, each signal contributes `n / (1 + n)` so a
 * very followed account cannot drown one people engage with.
 */
export async function refreshFollowRecommendations(env: RecommendationsEnv): Promise<number> {
  const since = `-${RECOMMENDATION_WINDOW_DAYS} days`;
  const [followed, interacted] = await Promise.all([
    env.DB.prepare(
      `SELECT f.target_id AS id, COUNT(*) AS n
       FROM follows f
       JOIN actors follower ON follower.id = f.actor_id AND follower.is_local = 1
       JOIN actors a ON a.id = f.target_id
       WHERE f.state = 'accepted'
         AND follower.last_active_at >= datetime('now', ?)
         AND a.suspended = 0 AND a.silenced = 0 AND COALESCE(a.memorial, 0) = 0 AND a.moved_to IS NULL
         AND NOT EXISTS (SELECT 1 FROM instance_domain_blocks idb WHERE idb.domain = a.domain AND idb.severity = 'suspend')
       GROUP BY f.target_id
       ORDER BY n DESC, f.target_id
       LIMIT ?`
    )
      .bind(since, RECOMMENDATION_LIMIT)
      .all<{ id: string; n: number }>(),
    // `INDEXED BY` + one branch per visibility keeps this an index seek: without
    // it the scan reads every object of the window (8.8 s vs 1.4 ms on cf-ap).
    env.DB.prepare(
      `SELECT actor_id AS id, SUM(engagement) AS n FROM (
         SELECT o.actor_id, o.engagement FROM objects o INDEXED BY idx_objects_trending
         WHERE o.visibility = 'public' AND o.type IN (${PUBLIC_STATUS_TYPE_SQL})
           AND o.engagement >= ${INTERACTION_FLOOR} AND o.published >= datetime('now', ?)
         UNION ALL
         SELECT o.actor_id, o.engagement FROM objects o INDEXED BY idx_objects_trending
         WHERE o.visibility = 'unlisted' AND o.type IN (${PUBLIC_STATUS_TYPE_SQL})
           AND o.engagement >= ${INTERACTION_FLOOR} AND o.published >= datetime('now', ?)
       ) GROUP BY actor_id ORDER BY n DESC, actor_id LIMIT ?`
    )
      .bind(since, since, RECOMMENDATION_LIMIT)
      .all<{ id: string; n: number }>(),
  ]);

  const scores = new Map<string, number>();
  for (const rows of [followed.results, interacted.results]) {
    for (const row of rows ?? []) {
      const n = Number(row.n) || 0;
      scores.set(row.id, (scores.get(row.id) ?? 0) + n / (1 + n));
    }
  }

  const ids = [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, RECOMMENDATION_LIMIT)
    .map(([id]) => id);

  await env.KV?.put(
    FOLLOW_RECOMMENDATIONS_KEY,
    JSON.stringify({ ids, updatedAt: new Date().toISOString() } satisfies FollowRecommendations),
    { expirationTtl: RECOMMENDATIONS_TTL_SECONDS }
  );
  return ids.length;
}

/** The stored ranking, or an empty list when it was never computed. */
export async function readFollowRecommendations(env: RecommendationsEnv): Promise<string[]> {
  if (!env.KV) return [];
  try {
    const raw = await env.KV.get(FOLLOW_RECOMMENDATIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { ids?: unknown };
    return Array.isArray(parsed.ids) ? parsed.ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}
