/**
 * useTimelineStream — React hook for Mastodon-compatible streaming via WebSocket.
 *
 * Connects to /api/v1/streaming?stream=<stream>[&tag=<tag>]
 * and delivers parsed Mastodon streaming events.  Reconnects automatically with
 * exponential back-off on connection loss.  Auth is handled via the auth_token cookie.
 *
 * Usage:
 *   useTimelineStream("public:local", (event, payload) => { ... });
 *   useTimelineStream("user", (event, payload) => { ... });
 */

import { useEffect, useRef } from "react";

type StreamEvent = "update" | "delete" | "notification" | "filters_changed" | string;

interface UseTimelineStreamOptions {
  /** Set to false to pause the connection without unmounting */
  enabled?: boolean;
  /** Extra query params to append to the WebSocket URL (e.g. { tag: "cats" }) */
  extraParams?: Record<string, string>;
}

export function useTimelineStream(
  stream: string,
  onEvent: (event: StreamEvent, payload: string) => void,
  options: UseTimelineStreamOptions = {}
): void {
  const { enabled = true, extraParams } = options;
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 1000;
    let destroyed = false;

    function connect() {
      if (destroyed) return;

      const url = new URL("/api/v1/streaming", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("stream", stream);
      if (extraParams) {
        for (const [k, v] of Object.entries(extraParams)) {
          url.searchParams.set(k, v);
        }
      }

      ws = new WebSocket(url.toString());

      ws.onopen = () => {
        retryDelay = 1000; // reset back-off on successful connection
      };

      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return;

        // Keep-alive pong
        if (event.data === "pong") return;

        try {
          const msg = JSON.parse(event.data) as { event?: string; payload?: string };
          if (msg.event && msg.payload !== undefined) {
            onEventRef.current(msg.event, msg.payload);
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        ws = null;
        if (!destroyed) {
          // Exponential back-off: 1s → 2s → 4s → … capped at 30s
          retryTimer = setTimeout(() => {
            retryDelay = Math.min(retryDelay * 2, 30_000);
            connect();
          }, retryDelay);
        }
      };

      ws.onerror = () => {
        ws?.close();
      };
    }

    connect();

    // Keep-alive ping every 25 seconds so proxies don't kill idle connections
    const pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send("ping");
      }
    }, 25_000);

    return () => {
      destroyed = true;
      if (retryTimer) clearTimeout(retryTimer);
      clearInterval(pingTimer);
      ws?.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, enabled]);
}
