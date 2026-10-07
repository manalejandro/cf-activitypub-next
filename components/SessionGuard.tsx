"use client";

import { useEffect } from "react";
import { clearToken, getToken } from "@/lib/client-api";

/**
 * Global session guard. When the browser holds a token the server no longer
 * honours — the account was suspended or deleted, or the session expired — every
 * API call would 401 and the app shell would render empty. Instead, clear the
 * stale token and land on the public page. Silenced (limited) accounts keep
 * their session: Mastodon's limitation only hides their posts from public
 * timelines.
 */
export function SessionGuard() {
  useEffect(() => {
    const token = getToken();
    if (!token) return;
    let cancelled = false;

    fetch("/api/auth/status", { credentials: "include", cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<{ authenticated?: boolean }>) : null))
      .then((data) => {
        if (cancelled || !data || data.authenticated) return;
        clearToken();
        if (window.location.pathname !== "/") window.location.replace("/");
      })
      .catch(() => { /* offline — keep the session until the server can confirm */ });

    return () => { cancelled = true; };
  }, []);

  return null;
}
