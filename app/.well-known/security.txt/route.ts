
// GET /.well-known/security.txt  (RFC 9116)
//
// Machine-readable security contact info. The Contact is the instance's
// configured sender email when set, otherwise the site root. Expires is rolled
// forward one year so the file never goes stale (RFC 9116 §2.5.2).
export async function GET(request: Request): Promise<Response> {
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  const contact = env.FROM_EMAIL
    ? `mailto:${env.FROM_EMAIL}`
    : baseUrl;

  const expires = new Date(Date.now() + 365 * 86400_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "+00:00");

  const body = [
    "# Security contact for " + baseUrl,
    "",
    "Contact: " + contact,
    "Expires: " + expires,
    "Preferred-Languages: en, es",
    "Canonical: " + baseUrl + "/.well-known/security.txt",
    "",
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
}
