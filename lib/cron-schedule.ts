/**
 * Per-stage cadence for the minute cron.
 *
 * The trigger must stay at `* * * * *` — a scheduled status has to go out on
 * time — but only a couple of stages need that resolution: the rest are
 * background work whose real cadence is minutes (or hours: the ones with their
 * own markers keep them). This tracker lets each stage declare its interval
 * without touching the trigger, and keeps the bookkeeping in **one** KV entry
 * (`cron:due`, stage → last run in ms) so a tick costs a single read and only
 * writes when something actually runs.
 *
 * A stage that throws still counts as run: the interval guards against a tight
 * retry loop, not against failures (the worker logs them).
 */

export const CRON_SCHEDULE_KEY = "cron:due";
/** Long enough that a quiet instance never loses a marker mid-interval. */
const CRON_SCHEDULE_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface CronScheduleKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface CronSchedule {
  /**
   * `true` the first time it is asked after `minutes` have passed for `stage`
   * (and then the clock restarts). `minutes <= 1` is always due.
   */
  every(stage: string, minutes: number): Promise<boolean>;
  /** Stage → last run (epoch ms), as loaded from KV. */
  snapshot(): Record<string, number>;
}

export function createCronSchedule(
  kv: CronScheduleKv,
  now: () => number = Date.now
): CronSchedule {
  let state: Record<string, number> | null = null;

  const load = async (): Promise<Record<string, number>> => {
    if (state) return state;
    const raw = await kv.get(CRON_SCHEDULE_KEY).catch(() => null);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        state = {};
        for (const [stage, at] of Object.entries(parsed)) {
          const value = Number(at);
          if (Number.isFinite(value) && value > 0) state[stage] = value;
        }
        return state;
      } catch {
        // A truncated entry starts the schedule over instead of stalling it.
      }
    }
    state = {};
    return state;
  };

  return {
    async every(stage: string, minutes: number): Promise<boolean> {
      if (minutes <= 1) return true;
      const current = await load();
      const timestamp = now();
      const last = current[stage] ?? 0;
      if (last > 0 && timestamp - last < minutes * 60_000) return false;
      current[stage] = timestamp;
      await kv
        .put(CRON_SCHEDULE_KEY, JSON.stringify(current), { expirationTtl: CRON_SCHEDULE_TTL_SECONDS })
        .catch(() => {});
      return true;
    },
    snapshot() {
      return { ...(state ?? {}) };
    },
  };
}
