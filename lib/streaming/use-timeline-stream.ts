/**
 * useTimelineStream — React hook for Mastodon-compatible streaming via WebSocket.
 *
 * Connects to /api/v1/streaming?stream=<stream>[&tag=<tag>]
 * and delivers parsed Mastodon streaming events. Reconnects automatically with
 * exponential back-off on connection loss. Auth is handled via the auth_token cookie.
 *
 * Sockets are SHARED per stream: several components (home feed, sidebar,
 * call overlay…) subscribe to the same `user` stream through one WebSocket,
 * and switching tabs reuses the connection instead of opening a second one.
 * `user:notification` is served from the `user` socket — the home channel
 * already forwards notification events — filtered to notifications only.
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
  /** Called each time the connection re-opens after a previous connection. */
  onReconnect?: () => void;
}

interface StreamListener {
  onEvent: (event: StreamEvent, payload: string) => void;
  onReconnect?: () => void;
  /** When set, only these events are delivered to this listener. */
  events?: Set<string>;
}

interface StreamEntry {
  ws: WebSocket | null;
  listeners: Set<StreamListener>;
  socketStream: string;
  params: Record<string, string>;
  retryDelay: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  closeTimer: ReturnType<typeof setTimeout> | null;
  destroyed: boolean;
  openedAt: number;
  everOpened: boolean;
}

/** Socket keep-alive after the last listener unmounts, so tab switches reuse it. */
const IDLE_CLOSE_MS = 30_000;
const PING_MS = 25_000;

const entries = new Map<string, StreamEntry>();

/** `user:notification` is a subset of `user`; both ride the same socket. */
function socketStreamFor(stream: string): string {
  return stream === "user:notification" ? "user" : stream;
}

function eventsFor(stream: string): Set<string> | undefined {
  return stream === "user:notification" ? new Set(["notification"]) : undefined;
}

function entryKey(socketStream: string, params?: Record<string, string>): string {
  const pairs = Object.entries(params ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return pairs.length ? `${socketStream}?${pairs.map(([k, v]) => `${k}=${v}`).join("&")}` : socketStream;
}

function connect(entry: StreamEntry): void {
  if (entry.destroyed) return;

  const url = new URL("/api/v1/streaming", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("stream", entry.socketStream);
  for (const [k, v] of Object.entries(entry.params)) {
    url.searchParams.set(k, v);
  }

  const ws = new WebSocket(url.toString());
  entry.ws = ws;

  ws.onopen = () => {
    entry.openedAt = Date.now();
    // Catch up after a reconnect: the gap between the old and new socket may
    // have dropped statuses the stream will not replay.
    if (entry.everOpened) {
      for (const listener of entry.listeners) {
        try {
          listener.onReconnect?.();
        } catch { /* a listener must never break the shared socket */ }
      }
    }
    entry.everOpened = true;
  };

  ws.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    if (event.data === "pong") return;

    let msg: { event?: string; payload?: string };
    try {
      msg = JSON.parse(event.data) as { event?: string; payload?: string };
    } catch {
      return;
    }
    if (!msg.event || msg.payload === undefined) return;

    for (const listener of entry.listeners) {
      if (listener.events && !listener.events.has(msg.event)) continue;
      listener.onEvent(msg.event, msg.payload);
    }
  };

  ws.onclose = () => {
    entry.ws = null;
    if (entry.destroyed) return;
    // Exponential back-off: 1s → 2s → 4s → … capped at 30s. Only reset it when
    // the previous connection actually opened and stayed up for a sustained
    // period (10s); a connection accepted-then-closed keeps doubling.
    if (entry.openedAt > 0 && Date.now() - entry.openedAt > 10_000) {
      entry.retryDelay = 1000;
    }
    entry.retryTimer = setTimeout(() => {
      entry.retryDelay = Math.min(entry.retryDelay * 2, 30_000);
      connect(entry);
    }, entry.retryDelay);
  };

  ws.onerror = () => {
    ws.close();
  };

  // Keep-alive ping so proxies don't kill idle connections.
  entry.pingTimer ??= setInterval(() => {
    if (entry.ws?.readyState === WebSocket.OPEN) {
      entry.ws.send("ping");
    }
  }, PING_MS);
}

function teardownEntry(key: string, entry: StreamEntry): void {
  entry.destroyed = true;
  if (entry.retryTimer) clearTimeout(entry.retryTimer);
  if (entry.pingTimer) clearInterval(entry.pingTimer);
  if (entry.closeTimer) clearTimeout(entry.closeTimer);
  entry.ws?.close();
  entries.delete(key);
}

function subscribe(
  stream: string,
  extraParams: Record<string, string> | undefined,
  listener: StreamListener
): () => void {
  const socketStream = socketStreamFor(stream);
  const key = entryKey(socketStream, extraParams);
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      ws: null,
      listeners: new Set(),
      socketStream,
      params: { ...(extraParams ?? {}) },
      retryDelay: 1000,
      retryTimer: null,
      pingTimer: null,
      closeTimer: null,
      destroyed: false,
      openedAt: 0,
      everOpened: false,
    };
    entries.set(key, entry);
    connect(entry);
  }
  if (entry.closeTimer) {
    clearTimeout(entry.closeTimer);
    entry.closeTimer = null;
  }
  entry.listeners.add(listener);

  return () => {
    const current = entries.get(key);
    if (!current || current !== entry) return;
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) {
      // Keep the socket briefly so a tab switch (unmount → remount) reuses it.
      entry.closeTimer = setTimeout(() => {
        if (entry.listeners.size === 0) teardownEntry(key, entry);
      }, IDLE_CLOSE_MS);
    }
  };
}

/** Test helper: drop every shared socket immediately. */
export function __resetSharedStreams(): void {
  for (const [key, entry] of entries) teardownEntry(key, entry);
}

export function useTimelineStream(
  stream: string,
  onEvent: (event: StreamEvent, payload: string) => void,
  options: UseTimelineStreamOptions = {}
): void {
  const { enabled = true, extraParams, onReconnect } = options;
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  });
  const onReconnectRef = useRef(onReconnect);
  useEffect(() => {
    onReconnectRef.current = onReconnect;
  });
  const extraParamsRef = useRef(extraParams);
  useEffect(() => {
    extraParamsRef.current = extraParams;
  });

  const paramsKey = extraParams
    ? Object.entries(extraParams).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&")
    : "";

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const listener: StreamListener = {
      onEvent: (event, payload) => onEventRef.current(event, payload),
      onReconnect: () => onReconnectRef.current?.(),
      events: eventsFor(stream),
    };
    return subscribe(stream, extraParamsRef.current, listener);
    // extraParams is tracked through paramsKey; the ref always holds the latest.
  }, [stream, enabled, paramsKey]);
}
