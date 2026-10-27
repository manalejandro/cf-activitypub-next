"use client";

import { useState, useEffect } from "react";

interface AuthState {
  loading: boolean;
  authenticated: boolean;
  actor: { id: string; username: string; displayName: string | null } | null;
}

const TOKEN_KEY = "access_token";

/**
 * The API token for calls that cannot ride the session cookie: WebSocket
 * upgrades take it as a query parameter, and some fetches attach it as an
 * explicit Authorization header. The web session itself lives in an **HttpOnly**
 * cookie (deliberately unreadable by JS — see `setAuthCookie`), so this
 * localStorage copy is a convenience credential, never the source of truth.
 * A cookie-only session (e.g. right after the HttpOnly migration) refreshes
 * this copy through `POST /api/auth/rotate` — see `SessionGuard`.
 */
export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch { /* private mode / quota — the cookie session still works */ }
}

export function clearToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
  // The HttpOnly cookie cannot be cleared from JS by design: the server
  // endpoints (/api/auth/logout, delete-account, revoke) expire it.
}

export interface EnsureTokenResult {
  /** The usable client-side token, or null when the session cannot hold one. */
  token: string | null;
  /** True when this call obtained the token via /api/auth/rotate (cookie-only session). */
  rotated: boolean;
}

let ensurePromise: Promise<EnsureTokenResult> | null = null;

/**
 * Resolve the client-side API token, healing a cookie-only session.
 *
 * The session cookie is HttpOnly, so a session that predates the localStorage
 * copy (or a browser that cleared it) has no token for the surfaces that need
 * one (WebSocket query params, `getToken()`-gated UI). This performs the
 * one-time `POST /api/auth/rotate` exchange — deduplicated across callers, and
 * retryable: a failed attempt clears the cached promise so the next navigation
 * tries again instead of leaving the app tokenless until a manual reload.
 *
 * `rotated` tells the caller that UI mounted before the token existed and may
 * need a refresh to pick it up.
 */
export function ensureToken(): Promise<EnsureTokenResult> {
  const existing = getToken();
  if (existing) return Promise.resolve({ token: existing, rotated: false });
  if (!ensurePromise) {
    ensurePromise = (async (): Promise<EnsureTokenResult> => {
      try {
        const statusRes = await fetch("/api/auth/status", { credentials: "include", cache: "no-store" });
        if (!statusRes.ok) return { token: null, rotated: false };
        const status = (await statusRes.json()) as { authenticated?: boolean };
        if (!status.authenticated) return { token: null, rotated: false };
        const res = await fetch("/api/auth/rotate", { method: "POST", credentials: "include" });
        if (!res.ok) return { token: null, rotated: false };
        const body = (await res.json()) as { access_token?: string };
        if (!body.access_token) return { token: null, rotated: false };
        setToken(body.access_token);
        // Blocked storage (strict private mode, full quota): the copy did not
        // stick. Report failure so callers never loop expecting a token.
        if (getToken() !== body.access_token) return { token: null, rotated: false };
        return { token: body.access_token, rotated: true };
      } catch {
        return { token: null, rotated: false };
      }
    })();
    ensurePromise.then((result) => {
      if (!result.token) ensurePromise = null; // retryable on the next call
    });
  }
  return ensurePromise;
}

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({ loading: true, authenticated: false, actor: null });

  useEffect(() => {
    fetch("/api/auth/status", { credentials: "include" })
      .then((r) => r.json() as Promise<{ authenticated: boolean; actor: { id: string; username: string; displayName: string | null } | null }>)
      .then((data) => {
        if (data.authenticated) {
          setState({ loading: false, authenticated: true, actor: data.actor });
        } else {
          setState({ loading: false, authenticated: false, actor: null });
        }
      })
      .catch(() => setState({ loading: false, authenticated: false, actor: null }));
  }, []);

  return state;
}

export function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...options,
    credentials: "include",
  });
}
