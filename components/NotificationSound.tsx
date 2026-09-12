"use client";

import { useEffect } from "react";

/**
 * When a notification arrives while the app is open: shows a tab badge and lets
 * the app re-sync its unread counter. The chime only plays for Web Push (the
 * service worker message) — i.e. when the tab is not focused and the server
 * actually delivered a push — never for the in-app streaming event.
 */
export function NotificationSound() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    const badging = navigator as unknown as { setAppBadge?: () => Promise<void>; clearAppBadge?: () => Promise<void> };

    let audio: HTMLAudioElement | null = null;
    let pending = 0;
    let lastSound = 0;
    let lastHandled = 0;
    const baseTitle = document.title;

    const playSound = () => {
      // A push and the streaming event can race for the same notification —
      // play at most once every 2s.
      const now = Date.now();
      if (now - lastSound < 2000) return;
      lastSound = now;
      audio ??= new Audio("/notification.ogg");
      audio.currentTime = 0;
      audio.play().catch(() => {});
    };

    const onNotification = (withSound: boolean) => {
      // `withSound` is only true for the SW push message (payload.sound is the
      // user's preference). Streaming notifications stay silent while the user
      // is looking at the app.
      if (withSound) playSound();

      // The push message and the streaming event can both fire for the same
      // notification — update the badge/dispatch once every 2s.
      const now = Date.now();
      if (now - lastHandled < 2000) return;
      lastHandled = now;

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
      if (e.data && e.data.type === "cfap:notification") onNotification(Boolean(e.data.sound));
    };

    const onStreamNotification = () => onNotification(false);

    navigator.serviceWorker.addEventListener("message", onSwMessage);
    window.addEventListener("cf-ap:notification-received", onStreamNotification);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") clearBadge();
    });
    window.addEventListener("focus", clearBadge);

    return () => {
      navigator.serviceWorker.removeEventListener("message", onSwMessage);
      window.removeEventListener("cf-ap:notification-received", onStreamNotification);
      document.removeEventListener("visibilitychange", clearBadge);
      window.removeEventListener("focus", clearBadge);
      audio?.pause();
      audio = null;
    };
  }, []);

  /**
   * Presence heartbeat: while this tab is focused, tell the server to skip Web
   * Push for this device — the in-app streaming event already plays the sound
   * and updates the badge. Without it Chrome shows an OS notification (and
   * beeps) while the user is looking at the app. Best-effort: a failed request
   * just means the OS notification still shows.
   */
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    const HEARTBEAT_MS = 60_000;
    let endpoint: string | null = null;
    let timer: number | null = null;
    let desired: boolean | null = null;
    let sent: boolean | null = null;
    let inFlight = false;

    const send = async (active: boolean, keepalive = false) => {
      try {
        if (!endpoint) {
          const registration = await navigator.serviceWorker.getRegistration();
          const subscription = await registration?.pushManager.getSubscription();
          if (!subscription) return;
          endpoint = subscription.endpoint;
        }
        await fetch("/api/v1/push/presence", {
          method: "POST",
          credentials: "include",
          keepalive,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active, endpoint }),
        });
      } catch {
        /* presence is best-effort */
      } finally {
        sent = active;
      }
    };

    // Send at most one request at a time so a heartbeat that was in flight when
    // the tab lost focus cannot land after (and override) the `active: false`.
    const flush = (force = false) => {
      if (inFlight) return;
      if (!force && desired === sent) return;
      const target = desired === true;
      inFlight = true;
      void send(target).finally(() => {
        inFlight = false;
        // The state changed while we were sending — correct it immediately.
        if (desired !== sent) flush();
      });
    };

    const sync = () => {
      desired = document.visibilityState === "visible" && document.hasFocus();
      if (desired) {
        flush();
        timer ??= window.setInterval(() => flush(true), HEARTBEAT_MS);
      } else {
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
        flush();
      }
    };

    sync();
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    const onPageHide = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      desired = false;
      // Bypass the queue: the page is going away, deliver the release now.
      void send(false, true);
    };
    window.addEventListener("pagehide", onPageHide);

    return () => {
      if (timer !== null) clearInterval(timer);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);

  return null;
}