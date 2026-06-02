/**
 * CallOverlayWrapper — client-side wrapper that reads the access token from
 * localStorage and renders the CallOverlay when authenticated.
 */
"use client";

import { useEffect, useState } from "react";
import { CallOverlay } from "./CallOverlay";

export function CallOverlayWrapper() {
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem("access_token");
      if (stored) setToken(stored);
    } catch { /* SSR or disabled storage */ }
  }, []);

  if (!token) return null;
  return <CallOverlay accessToken={token} />;
}
