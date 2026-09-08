"use client";

import { useEffect } from "react";

/**
 * Plays /notification.ogg when the service worker receives a push notification
 * and the user enabled the "play sound" preference. Service workers cannot play
 * audio themselves, so the SW posts a message to open windows and this mounts
 * the actual <audio> in the page.
 */
export function NotificationSound() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let audio: HTMLAudioElement | null = null;
    const onMessage = (event: MessageEvent) => {
      if (event.data && event.data.type === "cfap:notification-sound") {
        audio ??= new Audio("/notification.ogg");
        audio.currentTime = 0;
        audio.play().catch(() => {
          // Autoplay may be blocked; the visual notification still shows.
        });
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => {
      navigator.serviceWorker.removeEventListener("message", onMessage);
      audio?.pause();
      audio = null;
    };
  }, []);

  return null;
}