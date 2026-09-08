"use client";

import { useEffect } from "react";

/**
 * Registers the PWA service worker at the root scope.
 */
export function PwaRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch((err) => console.warn("[pwa] service worker registration failed:", err));
  }, []);

  return null;
}