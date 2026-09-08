"use client";

import { useEffect } from "react";

/**
 * Registers the PWA service worker. Plain and standard (see the Next.js PWA
 * guide): register /sw.js at root scope with updateViaCache: 'none' so the
 * browser always re-fetches it on navigation.
 */
export function PwaRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch((err) => console.warn("[pwa] service worker registration failed:", err));
  }, []);

  return null;
}