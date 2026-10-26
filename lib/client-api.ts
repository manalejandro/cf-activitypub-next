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
