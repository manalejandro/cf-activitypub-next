/**
 * Mastodon Relationship entity, computed from real DB state (follows, blocks,
 * mutes, endorsements, account notes and domain blocks) so no field is
 * hardcoded. Shared by the batch relationships endpoint and the single-action
 * routes (follow, block, mute, pin…) that return an updated relationship.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { getFollow, isBlocked } from "@/lib/db";

export interface MastodonRelationship {
  id: string;
  following: boolean;
  showing_reblogs: boolean;
  notifying: boolean;
  languages: null;
  followed_by: boolean;
  blocking: boolean;
  blocked_by: boolean;
  muting: boolean;
  muting_notifications: boolean;
  requested: boolean;
  requested_by: boolean;
  domain_blocking: boolean;
  endorsed: boolean;
  note: string;
}

export async function buildRelationship(
  db: D1Database,
  actorId: string,
  targetId: string,
  overrides: Partial<MastodonRelationship> = {}
): Promise<MastodonRelationship> {
  const [outgoing, incoming, blocking, blocked_by, mute, endorsed, noteRow, targetActor] = await Promise.all([
    getFollow(db, actorId, targetId),
    getFollow(db, targetId, actorId),
    isBlocked(db, actorId, targetId),
    isBlocked(db, targetId, actorId),
    db
      .prepare("SELECT notifications FROM mutes WHERE actor_id = ? AND target_id = ?")
      .bind(actorId, targetId)
      .first<{ notifications: number }>(),
    db
      .prepare("SELECT id FROM endorsements WHERE actor_id = ? AND target_id = ?")
      .bind(actorId, targetId)
      .first<{ id: string }>(),
    db
      .prepare("SELECT comment FROM account_notes WHERE actor_id = ? AND target_id = ?")
      .bind(actorId, targetId)
      .first<{ comment: string }>(),
    db.prepare("SELECT domain FROM actors WHERE id = ?").bind(targetId).first<{ domain: string }>(),
  ]);

  let domain_blocking = false;
  if (targetActor?.domain) {
    const dbRow = await db
      .prepare("SELECT id FROM domain_blocks WHERE actor_id = ? AND domain = ?")
      .bind(actorId, targetActor.domain)
      .first<{ id: string }>();
    domain_blocking = dbRow !== null;
  }

  return {
    id: targetId,
    following: outgoing?.state === "accepted",
    showing_reblogs: outgoing?.state === "accepted",
    notifying: false,
    languages: null,
    followed_by: incoming?.state === "accepted",
    blocking,
    blocked_by,
    muting: mute !== null,
    muting_notifications: mute?.notifications === 1,
    requested: outgoing?.state === "pending",
    requested_by: incoming?.state === "pending",
    domain_blocking,
    endorsed: endorsed !== null,
    note: noteRow?.comment ?? "",
    ...overrides,
  };
}