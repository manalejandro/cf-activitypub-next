"use client";

import { useEffect, useState } from "react";
import { DEFAULT_LIMITS, type InstanceLimits } from "@/lib/constants";
import { normalizeAnonymousTimelineAccess, type AnonymousTimelineAccess } from "@/lib/anonymous-timelines";

let cached: InstanceLimits = DEFAULT_LIMITS;
let cachedAnonymousTimelines: AnonymousTimelineAccess = "public";
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
        const payload = data as { limits?: InstanceLimits; anonymous_timelines?: string } | null;
        cached = payload?.limits ?? DEFAULT_LIMITS;
        cachedAnonymousTimelines = normalizeAnonymousTimelineAccess(payload?.anonymous_timelines);
        return cached;
      });
  }
  return promise;
}

/**
 * What anonymous visitors may see of the public timelines (instance setting,
 * default `public`). Shares the cached `/api/v1/instance` fetch with useLimits.
 */
export function useAnonymousTimelineAccess(): AnonymousTimelineAccess {
  const [access, setAccess] = useState<AnonymousTimelineAccess>(cachedAnonymousTimelines);
  useEffect(() => {
    let alive = true;
    fetchLimits().then(() => {
      if (alive) setAccess(cachedAnonymousTimelines);
    });
    return () => {
      alive = false;
    };
  }, []);
  return access;
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