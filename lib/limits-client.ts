"use client";

import { useEffect, useState } from "react";
import { DEFAULT_LIMITS, type InstanceLimits } from "@/lib/constants";

let cached: InstanceLimits = DEFAULT_LIMITS;
let promise: Promise<InstanceLimits> | null = null;

/**
 * Fetch the instance's effective limits (server resolves env overrides) once
 * per client session and expose them, so the UI honours the same limits the
 * API enforces instead of hardcoding defaults. Falls back to DEFAULT_LIMITS
 * while loading / on failure.
 */
function fetchLimits(): Promise<InstanceLimits> {
  if (!promise) {
    promise = fetch("/api/v1/instance", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((data) => {
        const limits = (data as { limits?: InstanceLimits } | null)?.limits;
        cached = limits ?? DEFAULT_LIMITS;
        return cached;
      });
  }
  return promise;
}

export function useLimits(): InstanceLimits {
  const [limits, setLimits] = useState<InstanceLimits>(cached);
  useEffect(() => {
    let alive = true;
    fetchLimits().then((l) => {
      if (alive) setLimits(l);
    });
    return () => {
      alive = false;
    };
  }, []);
  return limits;
}