/**
 * CallOverlayWrapper — client-side wrapper that reads the auth token from
 * cookie and renders the CallOverlay when authenticated.
 */
"use client";

import { useEffect, useState } from "react";
import { CallOverlay } from "./CallOverlay";
import { getToken } from "@/lib/client-api";

export function CallOverlayWrapper() {
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    setToken(getToken());
  }, []);

  if (!token) return null;
  return <CallOverlay accessToken={token} />;
}
