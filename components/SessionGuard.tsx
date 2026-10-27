"use client";

import { useEffect } from "react";
import { clearToken, ensureToken, getToken } from "@/lib/client-api";

const RELOAD_GUARD_KEY = "session_guard_rotated";

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
 *    cleared storage), heal it through `ensureToken()` (POST /api/auth/rotate)
 *    so WebSocket upgrades — which take ?access_token= and cannot read the
 *    HttpOnly cookie — and every `getToken()`-gated surface keep working.
 *    Pages read the token non-reactively at mount, so after a heal the page is
 *    reloaded ONCE (sessionStorage-guarded) to re-evaluate those gates.
 * 3. When the localStorage copy exists but the server rejects IT (stale or
 *    revoked token poisoning every `Authorization: Bearer` call while the
 *    cookie still works), drop the copy and heal as in (2).
 *
 * The probe is cheap for visitors without a session: /api/auth/status answers
 * from the missing token without touching the database.
 */
export function SessionGuard() {
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const stored = getToken();
      if (stored) {
        // Validate the bearer copy ALONE (credentials omitted so the cookie
        // cannot mask a dead token). A 401 here with a live cookie session is
        // the "schizophrenic app" case: every Authorization call fails while
        // cookie calls succeed — heal it below.
        try {
          const probe = await fetch("/api/auth/status", { credentials: "omit", cache: "no-store", headers: { Authorization: `Bearer ${stored}` } });
          const data = probe.ok ? (await probe.json() as { authenticated?: boolean }) : null;
          if (data?.authenticated) {
            // Token is live — nothing to do; retire the one-shot reload guard.
            try { sessionStorage.removeItem(RELOAD_GUARD_KEY); } catch { /* ignore */ }
            return;
          }
        } catch {
          return; // offline — keep the session until the server can confirm
        }
        clearToken();
      }

      const res = await fetch("/api/auth/status", { credentials: "include", cache: "no-store" }).catch(() => null);
      if (cancelled || !res || !res.ok) return;
      const data = (await res.json().catch(() => null)) as { authenticated?: boolean; reason?: string } | null;
      if (cancelled || !data) return;

      if (!data.authenticated) {
        // No `reason` means the visitor simply has no session — nothing to
        // guard, and anonymous visitors must never be redirected.
        if (!data.reason) return;
        clearToken();
        if (window.location.pathname !== "/") window.location.replace("/");
        return;
      }

      const result = await ensureToken();
      if (cancelled || !result.rotated) return;
      // Heal complete, but UI mounted before the token existed reads it as a
      // constant: reload once so gated surfaces (reply box, follow button,
      // WebSocket hooks) come up with the session. The guard makes it a
      // one-shot: if a reload somehow lands here again, never loop.
      try {
        if (sessionStorage.getItem(RELOAD_GUARD_KEY)) return;
        sessionStorage.setItem(RELOAD_GUARD_KEY, "1");
      } catch { /* storage blocked — skip the reload rather than risk a loop */ return; }
      window.location.reload();
    })().catch(() => { /* offline — keep the session until the server can confirm */ });

    return () => { cancelled = true; };
  }, []);

  return null;
}
