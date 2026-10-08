import { Suspense } from "react";
import LoginForm from "./LoginForm";
import { env } from "cloudflare:workers";

export default function LoginPage() {
  let turnstileSiteKey = "";
  try {
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
