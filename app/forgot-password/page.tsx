import { Suspense } from "react";
import ForgotPasswordForm from "./ForgotPasswordForm";
import { env } from "cloudflare:workers";

export default function ForgotPasswordPage() {
  let turnstileSiteKey = "";
  try {
    turnstileSiteKey = env.TURNSTILE_SITE_KEY ?? "";
  } catch {
    // Not in a Cloudflare context (local next dev)
  }
  return (
    <Suspense>
      <ForgotPasswordForm turnstileSiteKey={turnstileSiteKey} />
    </Suspense>
  );
}
