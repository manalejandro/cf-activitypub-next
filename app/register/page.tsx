import { Suspense } from "react";
import RegisterForm from "./RegisterForm";
import { getCloudflareContext } from "@/lib/cf";

export default function RegisterPage() {
  let turnstileSiteKey = "";
  try {
    const { env } = getCloudflareContext();
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
