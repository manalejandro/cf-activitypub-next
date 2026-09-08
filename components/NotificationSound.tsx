"use client";

import { useEffect } from "react";

/**
 * When a notification arrives while the app is open (via the service worker's
 * push message or a streaming notification event): plays the notification chime
 * (if enabled), shows a tab badge, and lets the app re-sync its unread counter.
 */
export function NotificationSound() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    const badging = navigator as unknown as { setAppBadge?: () => Promise<void>; clearAppBadge?: () => Promise<void> };

    let soundEnabled = false;
    let audio: HTMLAudioElement | null = null;
    let pending = 0;
    let lastFired = 0;
    const baseTitle = document.title;

    fetch("/api/v1/push/subscription", { credentials: "include", cache: "no-store" })
      .then((res) => (res.ok ? res.json() as Promise<{ sound: boolean }> : null))
      .then((data) => { if (data) soundEnabled = !!data.sound; })
      .catch(() => {});

    const onNotification = () => {
      // The push message and the streaming event can both fire for the same
      // notification — play at most once every 2s.
      const now = Date.now();
      if (now - lastFired < 2000) return;
      lastFired = now;

      if (soundEnabled) {
        audio ??= new Audio("/notification.ogg");
        audio.currentTime = 0;
        audio.play().catch(() => {});
      }
      if (!document.hasFocus()) {
        pending += 1;
        document.title = `(${pending}) ${baseTitle}`;
        badging.setAppBadge?.();
      }
      window.dispatchEvent(new Event("cf-ap:push-notification"));
    };

    const clearBadge = () => {
      if (pending > 0) {
        pending = 0;
        document.title = baseTitle;
        badging.clearAppBadge?.();
      }
    };

    const onSwMessage = (e: MessageEvent) => {
      if (e.data && e.data.type === "cfap:notification") onNotification();
    };

    navigator.serviceWorker.addEventListener("message", onSwMessage);
    window.addEventListener("cf-ap:notification-received", onNotification);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") clearBadge();
    });
    window.addEventListener("focus", clearBadge);

    return () => {
      navigator.serviceWorker.removeEventListener("message", onSwMessage);
      window.removeEventListener("cf-ap:notification-received", onNotification);
      document.removeEventListener("visibilitychange", clearBadge);
      window.removeEventListener("focus", clearBadge);
      audio?.pause();
      audio = null;
    };
  }, []);

  return null;
}