"use client";

import { getToken } from "@/lib/client-api";

/** Blocked account ids + blocked domains of the viewer. */
export interface BlockedAccounts {
  ids: Set<string>;
  domains: Set<string>;
}

const EMPTY: BlockedAccounts = { ids: new Set(), domains: new Set() };

let cached: Promise<BlockedAccounts> | null = null;

/**
 * The viewer's blocked accounts and domains, fetched once per session. Used to
 * filter streamed statuses on shared channels (public/hashtag), which are one
 * payload for every subscriber and cannot be filtered per viewer server-side.
 */
export function fetchBlockedAccounts(): Promise<BlockedAccounts> {
  if (!cached) {
    cached = (async () => {
      const token = getToken();
      if (!token) return EMPTY;
      const headers = { Authorization: `Bearer ${token}` };
      const ids = new Set<string>();
      // Bounded page walk: /api/v1/blocks paginates by offset. The effective
      // page size is the first page's length (the server caps `limit` at
      // maxCollectionPage), so a lowered cap never skips accounts.
      let step = 80;
      let offset = 0;
      for (let page = 0; page < 15 && step > 0; page++) {
        const res = await fetch(`/api/v1/blocks?limit=${step}&offset=${offset}`, { headers });
        if (!res.ok) break;
        const data = (await res.json()) as { id?: string }[];
        for (const account of data) if (account.id) ids.add(account.id);
        if (page === 0 && data.length > 0 && data.length < step) step = data.length;
        if (data.length < step) break;
        offset += data.length;
      }
      const domains = new Set<string>();
      try {
        const res = await fetch("/api/v1/domain_blocks", { headers });
        if (res.ok) {
          const data = (await res.json()) as string[];
          for (const domain of data) domains.add(domain.toLowerCase());
        }
      } catch { /* domains are best-effort */ }
      return { ids, domains };
    })().catch(() => EMPTY);
  }
  return cached;
}

/** Drop the cached sets: a block/unblock happened during this session. */
export function invalidateBlockedAccounts(): void {
  cached = null;
}

export type StreamedStatus = {
  account?: { id?: string; acct?: string } | null;
  in_reply_to_account_id?: string | null;
  reblog?: StreamedStatus | null;
};

function hostOf(iri: string): string | null {
  try {
    return new URL(iri).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function touchesBlocked(status: StreamedStatus | null | undefined, blocked: BlockedAccounts): boolean {
  if (!status) return false;
  const account = status.account;
  if (account?.id && blocked.ids.has(account.id)) return true;
  if (account) {
    const acctDomain = account.acct?.split("@")[1]?.toLowerCase();
    if (acctDomain && blocked.domains.has(acctDomain)) return true;
    const idHost = account.id ? hostOf(account.id) : null;
    if (idHost && blocked.domains.has(idHost)) return true;
  }
  const parent = status.in_reply_to_account_id;
  if (parent) {
    if (blocked.ids.has(parent)) return true;
    const host = hostOf(parent);
    if (host && blocked.domains.has(host)) return true;
  }
  return false;
}

/**
 * True when a streamed status is from — or replies to — an account (or domain)
 * the viewer blocked. Boost wrappers are checked on both the booster and the
 * boosted status.
 */
export function statusTouchesBlocked(status: StreamedStatus, blocked: BlockedAccounts): boolean {
  if (blocked.ids.size === 0 && blocked.domains.size === 0) return false;
  return touchesBlocked(status, blocked) || touchesBlocked(status.reblog, blocked);
}
