/**
 * Extra account fields that the status serializer embeds next to `last_status_at`:
 *  - `supports_calls` — remote authors report their instance's call capability
 *    (domain_capabilities); local accounts always support calls.
 *  - `moved` — the serialized target account when the author migrated
 *    (`movedTo`), so statuses show the same "moved" banner as the profile.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { getActorById, getActorFields, getDomainCallsSupport } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";
import type { LocalActor, MastodonAccount } from "@/lib/types";

export interface StatusAuthorExtras {
  supportsCalls?: boolean;
  moved: MastodonAccount | null;
}

/**
 * The account an actor migrated to, serialized for Mastodon's `moved` field.
 *
 * Every route that returns an account the client renders as a profile must fill
 * it: the web profile fetches `/api/v1/accounts/lookup`, which used to omit it,
 * so a moved account kept its follow button and showed no "moved" notice.
 */
export async function getMovedAccount(
  db: D1Database,
  actor: Pick<LocalActor, "movedTo">,
  localDomain: string
): Promise<MastodonAccount | null> {
  if (!actor.movedTo) return null;
  const moved = await getActorById(db, actor.movedTo);
  if (!moved) return null;
  const fields = await getActorFields(db, moved.id);
  return serializeAccount(moved, localDomain, { fields });
}

export async function getStatusAuthorExtras(
  db: D1Database,
  actorIds: string[],
  localDomain: string
): Promise<Map<string, StatusAuthorExtras>> {
  const map = new Map<string, StatusAuthorExtras>();
  const unique = [...new Set(actorIds)];
  if (unique.length === 0) return map;

  const actors = await Promise.all(unique.map((id) => getActorById(db, id)));
  const domainSupports = new Map<string, boolean>();

  for (const a of actors) {
    if (!a) continue;
    if (a.isLocal) {
      // Local accounts always support calls — serializeAccount's `?? isLocal`.
      map.set(a.id, { supportsCalls: undefined, moved: null });
      continue;
    }
    let supports = domainSupports.get(a.domain);
    if (supports === undefined) {
      supports = await getDomainCallsSupport(db, a.domain);
      domainSupports.set(a.domain, supports);
    }
    let moved: MastodonAccount | null = null;
    if (a.movedTo) {
      const movedActor = await getActorById(db, a.movedTo);
      if (movedActor) {
        const movedFields = await getActorFields(db, movedActor.id);
        moved = serializeAccount(movedActor, localDomain, { fields: movedFields });
      }
    }
    map.set(a.id, { supportsCalls: supports, moved });
  }
  return map;
}