/**
 * Migration aliases (`alsoKnownAs`) for local accounts — the destination half
 * of a profile move.
 *
 * A Move is only accepted when the account that receives the followers lists
 * the source as an alias, proving the user controls both accounts. Mastodon
 * keeps the list as actor IRIs, exposes it only in the AP document
 * (`alsoKnownAs`) and offers no REST endpoint for it (the web UI lives at
 * Preferences → Account → "Moving from a different account"). Here the handle
 * the user types is resolved — local accounts straight from the DB (never a
 * self-fetch: a Worker fetching its own hostname times out with HTTP 522),
 * remote ones through WebFinger plus the hardened actor fetch — and the IRI is
 * what we store.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { getActorById, getActorByUsername, updateActor } from "@/lib/db";
import { resolveWebFinger } from "@/lib/activitypub/federation";
import { fetchAndCacheRemoteActor } from "@/lib/activitypub/remote";
import type { LocalActor } from "@/lib/types";

export interface AliasTarget {
  /** Actor IRI, the value stored in `alsoKnownAs`. */
  uri: string;
  /** `@user@domain`, for display. */
  acct: string;
}

export type AliasResolution =
  | { ok: true; target: AliasTarget }
  | { ok: false; errorCode: string; error: string };

/** `@user@domain` for an actor IRI; the IRI itself when it cannot be parsed. */
export function aliasAcct(uri: string): string {
  try {
    const url = new URL(uri);
    const match = /\/(?:users\/|@)([^/?#]+)\/?$/.exec(url.pathname);
    if (match) return `@${decodeURIComponent(match[1])}@${url.hostname}`;
    return `@${url.hostname}${url.pathname}`;
  } catch {
    return uri;
  }
}

/** Resolve the handle a user typed into the actor it names. */
export async function resolveAliasTarget(
  db: D1Database,
  baseUrl: string,
  rawAcct: string,
  selfId: string
): Promise<AliasResolution> {
  const acct = rawAcct.trim().replace(/^@/, "");
  const [user, domain] = acct.split("@");
  if (!user || !domain || !domain.includes(".")) {
    return { ok: false, errorCode: "alias_error_invalid", error: "Expected a user@domain handle" };
  }

  const localDomain = new URL(baseUrl).hostname.toLowerCase();
  if (domain.toLowerCase() === localDomain) {
    const local = await getActorByUsername(db, user, localDomain);
    if (!local) {
      return { ok: false, errorCode: "alias_error_not_found", error: "No such account" };
    }
    if (local.id === selfId) {
      return { ok: false, errorCode: "alias_error_self", error: "That is this account" };
    }
    return { ok: true, target: { uri: local.id, acct: `@${local.username}@${localDomain}` } };
  }

  const resolvedUrl = await resolveWebFinger(acct);
  if (!resolvedUrl) {
    return { ok: false, errorCode: "alias_error_not_found", error: "Could not resolve that account" };
  }

  let target = await getActorById(db, resolvedUrl);
  if (!target) {
    const cached = await fetchAndCacheRemoteActor(db, resolvedUrl);
    if (!cached) {
      return { ok: false, errorCode: "alias_error_not_found", error: "Could not fetch that account" };
    }
    target = await getActorById(db, cached.id);
  }
  if (!target) {
    return { ok: false, errorCode: "alias_error_not_found", error: "No such account" };
  }
  if (target.id === selfId) {
    return { ok: false, errorCode: "alias_error_self", error: "That is this account" };
  }
  return { ok: true, target: { uri: target.id, acct: `@${target.username}@${target.domain}` } };
}

/** Add an alias (idempotent) and return the updated actor. */
export async function addAlias(db: D1Database, actor: LocalActor, target: AliasTarget): Promise<LocalActor> {
  const list = [...new Set([...(actor.alsoKnownAs ?? []), target.uri])];
  await updateActor(db, actor.id, { alsoKnownAs: list });
  return (await getActorById(db, actor.id)) ?? actor;
}

/** Remove an alias and return the updated actor. */
export async function removeAlias(db: D1Database, actor: LocalActor, uri: string): Promise<LocalActor> {
  const list = (actor.alsoKnownAs ?? []).filter((value) => value !== uri);
  await updateActor(db, actor.id, { alsoKnownAs: list });
  return (await getActorById(db, actor.id)) ?? actor;
}
