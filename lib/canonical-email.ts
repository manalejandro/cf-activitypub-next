/**
 * Canonical email normalization — anti-abuse (Mastodon's canonical email).
 *
 * Attackers register many accounts from one mailbox using free subaddresses
 * (`user+tag@domain`) and provider dot tricks (`u.s.e.r@domain`). Normalizing
 * the address lets the registration flow treat every variant of the same
 * mailbox as one identity: reject duplicates, count attempts per mailbox and
 * let admins block a mailbox outright.
 *
 * Normalization is applied to EVERY domain (not just Gmail): the local part is
 * lowercased, everything after `+` is dropped and dots are removed. `googlemail`
 * and `gmail` are the same mailbox.
 */

/** Normalize an address: lowercase, strip subaddress tags and dots. */
export function canonicalEmail(email: string): string {
  const trimmed = (email ?? "").trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return trimmed;
  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);

  // Everything after `+` is a free tag on every provider.
  local = local.split("+")[0];
  // Dots in the local part are ignored by Gmail/Outlook and are the cheapest
  // way to mint variants elsewhere, so they are ignored everywhere.
  local = local.replace(/\./g, "");
  // googlemail.com and gmail.com are the same mailbox.
  if (domain === "googlemail.com") domain = "gmail.com";
  return `${local}@${domain}`;
}

/** SHA-256 hex of the canonical address (stable key, no plaintext stored). */
export async function canonicalEmailHash(email: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalEmail(email)));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
