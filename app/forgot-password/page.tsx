import { Suspense } from "react";
import { getCloudflareContext } from "@/lib/cf";
import ForgotPasswordForm from "./ForgotPasswordForm";

export default function ForgotPasswordPage() {
  let turnstileSiteKey = "";
  try {
    const { env } = getCloudflareContext();
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
