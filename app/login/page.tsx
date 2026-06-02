import { Suspense } from "react";
import LoginForm from "./LoginForm";
import { getCloudflareContext } from "@/lib/cf";

export default function LoginPage() {
  let turnstileSiteKey = "";
  try {
    const { env } = getCloudflareContext();
    turnstileSiteKey = env.TURNSTILE_SITE_KEY ?? "";
  } catch {
    // Not in a Cloudflare context (local next dev)
  }
  return (
    <Suspense>
      <LoginForm turnstileSiteKey={turnstileSiteKey} />
    </Suspense>
  );
}
