import { Suspense } from "react";
import { getCloudflareContext } from "@/lib/cf";
import ResetPasswordForm from "./ResetPasswordForm";

export default function ResetPasswordPage() {
  let turnstileSiteKey = "";
  try {
    const { env } = getCloudflareContext();
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
