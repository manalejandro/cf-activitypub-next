"use client";

import { useEffect } from "react";

/**
 * Registers the PWA service worker. Only in production builds: during
 * development the SW's caches would mask fresh assets.
 */
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV === "development") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch((err) => console.warn("[pwa] service worker registration failed:", err));
  }, []);

  return null;
}