/**
 * Local account deletion — the single implementation shared by the owner's
 * self-delete, the admin DELETE route and the inactivity purge.
 *
 * It federates a `Delete{Actor}` tombstone to every accepted follower (the
 * account and its posts disappear from the fediverse), drops the rows that
 * reference the actor without a foreign key (`oauth_tokens`, `activities`,
 * `moderation_log`), removes the account's own R2 uploads (avatar, header and
 * attachment files — the *federated* media cache entries are left to its own
 * maintenance, which resets every reference before deleting), deletes the actor
 * row (cascades remove objects, attachments, follows…) and records a moderation
 * entry.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { collectFollowerInboxes } from "@/lib/activitypub/federation";
import { enqueueDeliveries } from "@/lib/activitypub/queue";
import { buildDelete, generateId } from "@/lib/activitypub/utils";
import { recordModeration, type ModerationSource } from "@/lib/moderation/log";
import { getActorById } from "@/lib/db";
import type { APActor, LocalActor } from "@/lib/types";

/** Minimal R2 surface (the generated binding and workers-types disagree). */
export interface DeletionR2 {
  list(options: { prefix: string; limit?: number }): Promise<{ objects: { key: string }[] }>;
  delete(key: string | string[]): Promise<void>;
}

export interface AccountDeletionEnv {
  DB: D1Database;
  R2?: DeletionR2;
  DELIVERY_QUEUE?: Queue;
  KV?: { delete(key: string): Promise<unknown> };
}

export interface AccountDeletionResult {
  /** Accepted follower inboxes the Delete{Actor} was queued to. */
  federated: number;
  /** R2 objects removed (uploads of the deleted account). */
  mediaDeleted: number;
}

/** R2 keys of the account's own uploads (never the shared media cache). */
async function accountMediaKeys(env: AccountDeletionEnv, actor: LocalActor): Promise<string[]> {
  const keys = new Set<string>();
  // Upload keys are namespaced by username only (`avatars/<username>.<ext>`),
  // so a remote actor with the same username must never touch them.
  if (!env.R2 || !actor.isLocal) return [];

  // Avatars/headers are keyed by username (whatever their extension).
  for (const prefix of [`avatars/${actor.username}.`, `headers/${actor.username}.`]) {
    try {
      const listed = await env.R2.list({ prefix, limit: 100 });
      for (const object of listed.objects) keys.add(object.key);
    } catch { /* best-effort */ }
  }

  // Attachment uploads are served from `<baseUrl>/api/media/<key>`; cached
  // federated media (`cache/media/...`) is shared by several posts and is
  // cleaned by the media cache maintenance instead.
  try {
    const rows = await env.DB
      .prepare(
        `SELECT a.url FROM attachments a
         JOIN objects o ON o.id = a.object_id
         WHERE o.actor_id = ? AND a.url LIKE '%/api/media/%'`
      )
      .bind(actor.id)
      .all<{ url: string }>();
    for (const row of rows.results) {
      const match = /\/api\/media\/(.+)$/.exec(row.url ?? "");
      if (!match) continue;
      const key = decodeURIComponent(match[1]);
      if (key.startsWith("cache/media/")) continue;
      keys.add(key);
    }
  } catch { /* best-effort */ }

  return [...keys];
}

/**
 * Delete a local account. Callers own the authorization checks (self-delete,
 * `accountActionGuard`, the inactivity sweep) and any response concerns
 * (clearing the session cookie…).
 */
export async function deleteLocalAccount(
  env: AccountDeletionEnv,
  actor: LocalActor,
  opts: { baseUrl: string; reason: string; source: ModerationSource; details?: Record<string, unknown>; emailSent?: boolean }
): Promise<AccountDeletionResult> {
  const result: AccountDeletionResult = { federated: 0, mediaDeleted: 0 };

  // Federate a Delete(actor) tombstone before the actor row disappears. Only
  // local accounts have a private key; the caller only passes local ones.
  if (actor.privateKeyPem && env.DELIVERY_QUEUE && opts.baseUrl.startsWith("https://")) {
    try {
      const deleteActivity = buildDelete(opts.baseUrl, actor.id, actor.id, generateId());
      const followers = await env.DB
        .prepare("SELECT actor_id FROM follows WHERE target_id = ? AND state = 'accepted'")
        .bind(actor.id)
        .all<{ actor_id: string }>();
      const fetchActor = async (id: string): Promise<APActor | null> =>
        (await getActorById(env.DB, id)) as unknown as APActor | null;
      const inboxes = await collectFollowerInboxes(followers.results.map((r) => r.actor_id), fetchActor);
      if (inboxes.length > 0) {
        await enqueueDeliveries(
          env.DELIVERY_QUEUE,
          inboxes,
          JSON.stringify(deleteActivity),
          actor.id,
          `${actor.id}#main-key`,
          actor.privateKeyPem
        );
        result.federated = inboxes.length;
      }
    } catch (err) {
      console.error(`[account-deletion] Delete{Actor} for ${actor.id} failed`, err);
    }
  }

  // Uploads first: the attachment rows are gone after the actor delete.
  const keys = await accountMediaKeys(env, actor);
  if (env.R2 && keys.length > 0) {
    for (const key of keys) {
      try {
        await env.R2.delete(key);
        result.mediaDeleted += 1;
      } catch { /* best-effort */ }
    }
  }

  // Sessions + audit trail reference the actor without an FK, so clear them
  // explicitly before the cascading actor delete.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_tokens WHERE actor_id = ?").bind(actor.id),
    env.DB.prepare("DELETE FROM activities WHERE actor_id = ?").bind(actor.id),
    env.DB.prepare("DELETE FROM moderation_log WHERE target_id = ?").bind(actor.id),
    env.DB.prepare("DELETE FROM actors WHERE id = ?").bind(actor.id),
  ]);

  // Expiration warning markers are keyed by actor id: without this a recycled
  // id would inherit a stale "already warned" state.
  if (env.KV) {
    await env.KV.delete(`expiry:warn:7:${actor.id}`).catch(() => {});
    await env.KV.delete(`expiry:warn:1:${actor.id}`).catch(() => {});
  }

  await recordModeration(env, {
    id: generateId(),
    source: opts.source,
    targetType: "account",
    targetId: actor.id,
    action: "deleted",
    reason: opts.reason,
    confidence: null,
    model: opts.source === "heuristic" ? "heuristic" : "admin",
    details: { username: actor.username, domain: actor.domain, mediaDeleted: result.mediaDeleted, ...(opts.details ?? {}) },
    emailSent: opts.emailSent ?? false,
    emailTo: actor.email,
    relatedId: null,
  });

  return result;
}
