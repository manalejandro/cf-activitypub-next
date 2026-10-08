import { Suspense } from "react";
import ResetPasswordForm from "./ResetPasswordForm";
import { env } from "cloudflare:workers";

export default function ResetPasswordPage() {
  let turnstileSiteKey = "";
  try {
    turnstileSiteKey = env.TURNSTILE_SITE_KEY ?? "";
  } catch {
    // Not in a Cloudflare context (local next dev)
  }
  return (
    <Suspense>
      <ResetPasswordForm turnstileSiteKey={turnstileSiteKey} />
    </Suspense>
  );
}
