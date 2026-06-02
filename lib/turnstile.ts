/**
 * Cloudflare Turnstile server-side verification.
 * Docs: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstileToken(
  token: string | null | undefined,
  secret: string,
  remoteIp?: string
): Promise<boolean> {
  if (!token) return false;

  const body: Record<string, string> = { secret, response: token };
  if (remoteIp) body.remoteip = remoteIp;

  const res = await fetch(SITEVERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) return false;

  const data = await res.json() as { success: boolean; "error-codes"?: string[] };
  return data.success === true;
}
