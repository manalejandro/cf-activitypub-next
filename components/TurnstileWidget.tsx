"use client";

import { useCallback, useEffect, useRef } from "react";

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  remove(id: string): void;
  reset(id: string): void;
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
}: {
  siteKey: string;
  action: string;
  onToken: (token: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  useEffect(() => {
    onTokenRef.current = onToken;
  });

  const init = useCallback(() => {
    const api = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
    if (!siteKey || !api || !containerRef.current || widgetIdRef.current) return;
    widgetIdRef.current = api.render(containerRef.current, {
      sitekey: siteKey,
      action,
      callback: (token: string) => onTokenRef.current(token),
      "expired-callback": () => onTokenRef.current(""),
      "error-callback": () => onTokenRef.current(""),
    });
  }, [siteKey, action]);

  useEffect(() => {
    init();
    return () => {
      const api = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
      if (api && widgetIdRef.current) api.remove(widgetIdRef.current);
      widgetIdRef.current = null;
    };
  }, [init]);

  if (!siteKey) return null;
  return (
    <>
      <script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        async
        defer
        onLoad={init}
      />
      <div ref={containerRef} style={{ minHeight: "65px" }} />
    </>
  );
}
