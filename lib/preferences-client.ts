"use client";

import { useEffect, useState } from "react";

let cached: Record<string, unknown> = {};
let promise: Promise<Record<string, unknown>> | null = null;

/**
 * Fetch /api/v1/preferences once per client session (module-level cache) and
 * expose them. Used by UI components (e.g. StatusCard) to honour reading
 * preferences instead of hardcoding defaults.
 */
export function fetchPreferences(): Promise<Record<string, unknown>> {
  if (!promise) {
    promise = fetch("/api/v1/preferences", { credentials: "include" })
      .then((res) => (res.ok ? res.json() as Promise<Record<string, unknown>> : {}))
      .catch(() => ({}))
      .then((data) => { cached = data; return data; });
  }
  return promise;
}

export function usePreferences(): Record<string, unknown> {
  const [prefs, setPrefs] = useState<Record<string, unknown>>(cached);
  useEffect(() => {
    let alive = true;
    fetchPreferences().then((data) => { if (alive) setPrefs(data); });
    return () => { alive = false; };
  }, []);
  return prefs;
}