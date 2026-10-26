"use client";

import { useState } from "react";
import TurnstileWidget from "@/components/TurnstileWidget";

/**
 * Turnstile for plain server-rendered forms (the OAuth consent page posts
 * natively, with no JS submit handler to attach the token to): renders the
 * widget and keeps a hidden `cf-turnstile-response` input inside the enclosing
 * form in sync, so the native POST carries the token. Renders nothing when the
 * instance has no site key — the server side decides whether a missing token
 * is acceptable (`enforceTurnstilePolicy` skips only when no secret is set).
 */
export default function TurnstileFormWidget({ siteKey, action }: { siteKey: string; action: string }) {
  const [token, setToken] = useState("");
  if (!siteKey) return null;
  return (
    <>
      <input type="hidden" name="cf-turnstile-response" value={token} />
      <TurnstileWidget siteKey={siteKey} action={action} onToken={setToken} />
    </>
  );
}
