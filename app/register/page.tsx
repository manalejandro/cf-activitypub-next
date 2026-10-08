import { Suspense } from "react";
import RegisterForm from "./RegisterForm";
import { env } from "cloudflare:workers";

export default function RegisterPage() {
  let turnstileSiteKey = "";
  try {
    turnstileSiteKey = env.TURNSTILE_SITE_KEY ?? "";
  } catch {
    // Not in a Cloudflare context (local next dev)
  }
  return (
    <Suspense>
      <RegisterForm turnstileSiteKey={turnstileSiteKey} />
    </Suspense>
  );
}
