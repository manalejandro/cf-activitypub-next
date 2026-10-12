"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

/**
 * Relative timestamps that keep ticking.
 *
 * `StatusCard` is memoised and its props are stable, so a label computed at
 * render froze at "5s" until something else re-rendered the card. Every
 * `<RelativeTime>` subscribes to one document-wide ticker (a single interval,
 * however many cards are on screen) and re-renders only its own span — and
 * only when the label would actually change: seconds tick every second,
 * minutes/hours wait for their own boundary, a date waits for midnight.
 */

const TICK_MS = 1000;
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  for (const notify of subscribers) notify();
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  if (subscribers.size === 1) {
    timer = setInterval(tick, TICK_MS);
    // Browsers clamp timers in background tabs: catch up on return.
    document.addEventListener("visibilitychange", tick);
  }
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
      document.removeEventListener("visibilitychange", tick);
    }
  };
}

/** "5s" / "3m" / "2h" while fresh, an absolute date after a day. */
export function formatRelativeTime(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  const diff = (now - date.getTime()) / 1000;
  if (diff < 60) return `${Math.floor(Math.max(diff, 0))}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return date.toLocaleDateString();
}

/**
 * A number that changes exactly when the label does: the seconds value under a
 * minute, then the minute/hour/day the label is counting. Comparing it avoids
 * re-rendering (and re-running `toLocaleDateString`) on every tick.
 */
function labelUnit(diffSec: number): number {
  if (diffSec < 60) return Math.floor(diffSec);
  if (diffSec < 3600) return 60 + Math.floor(diffSec / 60);
  if (diffSec < 86400) return 120 + Math.floor(diffSec / 3600);
  return 144 + Math.floor(diffSec / 86400);
}

export function RelativeTime({
  iso,
  title,
  style,
  className,
}: {
  iso: string;
  title?: string;
  style?: CSSProperties;
  className?: string;
}) {
  const [label, setLabel] = useState(() => formatRelativeTime(iso));
  const unit = useRef<number | null>(null);

  useEffect(() => {
    const update = () => {
      const next = labelUnit((Date.now() - new Date(iso).getTime()) / 1000);
      if (next === unit.current) return;
      unit.current = next;
      setLabel(formatRelativeTime(iso));
    };
    update();
    return subscribe(update);
  }, [iso]);

  // The server and the client compute the label a moment apart: a text
  // mismatch here is expected and harmless.
  return (
    <span suppressHydrationWarning className={className} style={style} title={title}>
      {label}
    </span>
  );
}
