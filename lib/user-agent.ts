/**
 * Federated User-Agent for outbound ActivityPub requests.
 *
 * Cloudflare Workers' `fetch` sends **no** User-Agent by default, and strict
 * servers reject such requests outright — GoToSocial answers 418 "I'm a teapot:
 * no user-agent sent with request" (WebFinger, actor documents, inbox
 * deliveries…), which silently broke remote resolution and delivery to those
 * instances. Every outbound federation request must therefore carry one; the
 * choke points (`safeFetchTracked`, the media cache fetcher) set this when the
 * caller did not.
 */

import { env } from "cloudflare:workers";

/** Bot UA: `CFActivityPub/<version> (+<INSTANCE_URL>)`. */
export function federationUserAgent(): string {
  try {
    const e = env as unknown as Record<string, string | undefined>;
    const version = e.INSTANCE_VERSION ?? "0.1.0";
    const domain = new URL(e.INSTANCE_URL ?? "http://localhost:3000").hostname;
    return `CFActivityPub/${version} (+https://${domain})`;
  } catch {
    return "CFActivityPub/0.1.0 (+http://localhost:3000)";
  }
}

/**
 * Browser fallback UA: some servers' anti-bot guards reject bot-looking
 * clients (Friendica), so the actor fetcher retries with this.
 */
export const FEDERATION_BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0";
