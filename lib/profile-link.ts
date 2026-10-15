/**
 * Profile URL for an account entity, shared by every surface that links one
 * (admin tables, notifications): local accounts get their own profile page,
 * remote ones resolve through the local `/users/remote` viewer — the account
 * IRI, never the remote web URL, so the page stays on this instance.
 */
export function profileHref(account: { id: string; username: string; acct: string }): string {
  return account.acct.includes("@")
    ? `/users/remote?url=${encodeURIComponent(account.id)}`
    : `/users/${encodeURIComponent(account.username)}`;
}
