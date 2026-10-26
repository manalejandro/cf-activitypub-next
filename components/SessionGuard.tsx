"use client";

import { useEffect } from "react";
import { clearToken, getToken, setToken } from "@/lib/client-api";

/**
 * Global session guard.
 *
 * 1. When the server rejects a session it recognizes (the account was
 *    suspended or deleted, the token expired), clear the client copy and land
 *    on the public page — every API call would 401 otherwise and the app shell
 *    would render empty. Silenced (limited) accounts keep their session:
 *    Mastodon's limitation only hides their posts from public timelines.
 * 2. When the session IS valid but the localStorage copy of the token is
 *    missing (a cookie-only session predating the HttpOnly migration, or a
 *    cleared storage), rotate the session so WebSocket upgrades — which take
 *    ?access_token= and cannot read the HttpOnly cookie — keep working.
 *
 * The probe is cheap for visitors without a session: /api/auth/status answers
 * from the missing token without touching the database.
 */
export function SessionGuard() {
  useEffect(() => {
    let cancelled = false;

    fetch("/api/auth/status", { credentials: "include", cache: "no-store" })
      .then((res) =>
        res.ok ? (res.json() as Promise<{ authenticated?: boolean; reason?: string }>) : null
      )
      .then(async (data) => {
        if (cancelled || !data) return;

        if (!data.authenticated) {
          // No `reason` means the visitor simply has no session — nothing to
          // guard, and anonymous visitors must never be redirected.
          if (!data.reason) return;
          clearToken();
          if (window.location.pathname !== "/") window.location.replace("/");
          return;
        }

        if (getToken()) return;
        try {
          const res = await fetch("/api/auth/rotate", { method: "POST", credentials: "include" });
          if (!res.ok) return;
          const body = (await res.json()) as { access_token?: string };
          if (!cancelled && body.access_token) setToken(body.access_token);
        } catch { /* offline — the cookie session still works for REST */ }
      })
      .catch(() => { /* offline — keep the session until the server can confirm */ });

    return () => { cancelled = true; };
  }, []);

  return null;
}
