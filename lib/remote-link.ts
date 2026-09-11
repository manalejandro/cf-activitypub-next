/**
 * Remote-handle URLs (`/@user@domain`) are external links: Mastodon never
 * resolves them in place, it shows a "you are about to leave" interstitial
 * pointing at the account on its home instance. Resolution only happens through
 * the authenticated account endpoint.
 */
export function externalProfileUrl(
  handle: string,
  rest = "",
  ownHostname?: string
): string | null {
  const at = handle.indexOf("@");
  if (at <= 0) return null;
  const user = handle.slice(0, at);
  const domain = handle.slice(at + 1);
  if (!user || !domain) return null;
  // Same-instance handles (`/@alice@cf-ap.com` on cf-ap.com) stay local.
  if (ownHostname && domain.toLowerCase() === ownHostname.toLowerCase()) return null;
  return `https://${domain}/@${user}${rest}`;
}
