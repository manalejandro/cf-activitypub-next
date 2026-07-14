"use client";

import { useState, useEffect } from "react";

interface AuthState {
  loading: boolean;
  authenticated: boolean;
  actor: { id: string; username: string; displayName: string | null } | null;
}

export function getToken(): string | null {
  if (typeof document === "undefined") return null;

  const match = document.cookie.match(/(?:^|;\s*)auth_token=([^;]+)/);
  if (match) return decodeURIComponent(match[1]);

  const stored = localStorage.getItem("access_token");
  if (stored) {
    document.cookie = `auth_token=${encodeURIComponent(stored)}; Secure; SameSite=Lax; Path=/; Max-Age=${3600 * 24 * 30}`;
    localStorage.removeItem("access_token");
    return stored;
  }

  return null;
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
