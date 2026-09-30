"use client";

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  remove(id: string): void;
  reset(id: string): void;
}

export interface TurnstileHandle {
  /** Reset the widget: a solved token is single-use, so retries need a new one. */
  reset(): void;
}

function turnstileApi(): TurnstileApi | undefined {
  return (window as unknown as { turnstile?: TurnstileApi }).turnstile;
}

// One loader per document. Client-side navigation (login ↔ register ↔
// forgot/reset) remounts the widget on an already-loaded script, so waiting for
// a script `onLoad` that only ever fires once left the box empty.
let loader: Promise<void> | null = null;

function loadTurnstile(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (turnstileApi()) return Promise.resolve();
  if (loader) return loader;

  loader = new Promise<void>((resolve) => {
    const settle = () => resolve();
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
    if (existing) {
      // Injected by an earlier screen (or by `next/script`): wait for the API
      // itself, since that element will not fire `load` again.
      if (turnstileApi()) return settle();
      existing.addEventListener("load", settle, { once: true });
      const poll = window.setInterval(() => {
        if (turnstileApi()) {
          window.clearInterval(poll);
          settle();
        }
      }, 100);
      window.setTimeout(() => window.clearInterval(poll), 15_000);
      return;
    }
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", settle, { once: true });
    script.addEventListener(
      "error",
      () => {
        // Let a later mount retry instead of caching the failure.
        loader = null;
        settle();
      },
      { once: true }
    );
    document.head.appendChild(script);
  });
  return loader;
}

/**
 * Cloudflare Turnstile widget (explicit render). Renders nothing when the
 * instance has no site key configured, so local dev keeps working; the server
 * side decides whether a missing token is acceptable (`enforceTurnstilePolicy`
 * skips only when TURNSTILE_SECRET is unset).
 */
export default function TurnstileWidget({
  siteKey,
  action,
  onToken,
  theme = "auto",
  ref,
}: {
  siteKey: string;
  action: string;
  onToken: (token: string) => void;
  theme?: "auto" | "light" | "dark";
  ref?: Ref<TurnstileHandle>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  useEffect(() => {
    onTokenRef.current = onToken;
  });

  useImperativeHandle(
    ref,
    () => ({
      reset() {
        const api = turnstileApi();
        if (api && widgetIdRef.current) {
          api.reset(widgetIdRef.current);
          onTokenRef.current("");
        }
      },
    }),
    []
  );

  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;
    void loadTurnstile().then(() => {
      const api = turnstileApi();
      if (cancelled || !api || !containerRef.current || widgetIdRef.current) return;
      widgetIdRef.current = api.render(containerRef.current, {
        sitekey: siteKey,
        action,
        theme,
        callback: (token: string) => onTokenRef.current(token),
        "expired-callback": () => onTokenRef.current(""),
        "error-callback": () => onTokenRef.current(""),
      });
    });
    return () => {
      cancelled = true;
      const api = turnstileApi();
      if (api && widgetIdRef.current) {
        try {
          api.remove(widgetIdRef.current);
        } catch {
          /* widget already gone */
        }
      }
      widgetIdRef.current = null;
    };
  }, [siteKey, action, theme]);

  if (!siteKey) return null;
  return <div ref={containerRef} style={{ minHeight: "65px" }} />;
}
