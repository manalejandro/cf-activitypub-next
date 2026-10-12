/**
 * Parse what someone typed into an account search box.
 *
 * Mirrors Mastodon's `AccountSearchService` (which strips one leading `@`, so
 * `@user@domain` resolves) plus `ResolveURLService` (a pasted profile URL names
 * an account: `https://domain/@user` and `https://domain/users/user`, local or
 * remote).
 */

export interface AccountQuery {
  /** Text for the LIKE fallback (username prefix / display-name substring). */
  text: string;
  /** Set when the query names one account exactly. */
  username?: string;
  domain?: string;
  /** The query was a profile URL. */
  isUrl?: boolean;
}

export function parseAccountQuery(raw: string): AccountQuery {
  const q = (raw ?? "").trim();
  if (!q) return { text: "" };

  const url = /^https?:\/\/([^/\s?#]+)\/(?:@|users\/)([^/?#\s]+)\/?$/i.exec(q);
  if (url) {
    let username = url[2];
    try {
      username = decodeURIComponent(username);
    } catch { /* keep the raw segment */ }
    return { text: q, username, domain: url[1].toLowerCase(), isUrl: true };
  }

  const handle = q.replace(/^@/, "");
  const at = handle.indexOf("@");
  if (at > 0) {
    const username = handle.slice(0, at);
    const domain = handle.slice(at + 1).toLowerCase();
    if (username && domain) return { text: q, username, domain };
  }
  return { text: handle };
}
