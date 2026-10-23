/**
 * Extra account fields that the status serializer embeds next to `last_status_at`:
 *  - `supports_calls` — remote authors report their instance's call capability
 *    (domain_capabilities); local accounts always support calls.
 *  - `moved` — the serialized target account when the author migrated
 *    (`movedTo`), so statuses show the same "moved" banner as the profile.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { getActorById, getActorFields, getActorFieldsMap, getActorsByIds, getDomainCallsSupportMap } from "@/lib/db";
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
  const unique = [...new Set(actorIds)].filter(Boolean);
  if (unique.length === 0) return map;

  // One query per concern, never one per author: a timeline page renders up to
  // ~40 statuses from as many remote instances, and the per-author plus
  // per-domain round-trip chain cost ~60 ms per status (measured on cf-ap).
  const actors = await getActorsByIds(db, unique);
  const remoteActors = [...actors.values()].filter((a) => !a.isLocal);
  const movedIds = [...new Set(remoteActors.map((a) => a.movedTo).filter((id): id is string => Boolean(id)))];

  const [domainSupports, movedActors, movedFields] = await Promise.all([
    getDomainCallsSupportMap(db, remoteActors.map((a) => a.domain)),
    getActorsByIds(db, movedIds),
    getActorFieldsMap(db, movedIds),
  ]);

  for (const [id, a] of actors) {
    if (a.isLocal) {
      // Local accounts always support calls — serializeAccount's `?? isLocal`.
      map.set(id, { supportsCalls: undefined, moved: null });
      continue;
    }
    let moved: MastodonAccount | null = null;
    if (a.movedTo) {
      const movedActor = movedActors.get(a.movedTo);
      if (movedActor) {
        moved = serializeAccount(movedActor, localDomain, { fields: movedFields.get(movedActor.id) ?? [] });
      }
    }
    map.set(id, { supportsCalls: domainSupports.get(a.domain) ?? false, moved });
  }
  return map;
}