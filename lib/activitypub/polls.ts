/**
 * Refresh a locally cached poll from an ActivityPub `Question`.
 *
 * Remote vote counts only reach us through the origin's document (votes are
 * addressed to the poll author, not broadcast), so the poll detail refreshes
 * it on access and `Update{Question}` activities apply it too.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { getPollByObjectId, getPollOptions, getPollsByObjectIds, listLocalPollVoters, listPollsToNotify, setPollVoteCounts } from "@/lib/db";
import { fetchRemoteObject } from "@/lib/activitypub/federation";
import { notify, type NotifyEnv } from "@/lib/notify";
import { generateId, isoTimestamp } from "@/lib/activitypub/utils";
import type { APNote, LocalObject, LocalPoll, LocalPollOption } from "@/lib/types";

interface RefreshBindings {
  DB: D1Database;
  KV: { get(key: string): Promise<string | null>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> };
}

/**
 * Notify the people a poll owes an answer to once it expires — Mastodon's
 * `PollExpirationNotifyWorker`: the **local voters** (`notify_local_voters!`,
 * for local and remote polls alike) and the author (`notify_remote_voters_and_owner!`,
 * local polls). Remote polls are the case that used to be silent: their author
 * is remote, so nothing local was ever told, and the notification only needs
 * our own rows — never the origin.
 *
 * The author's notification doubles as the marker: `listPollsToNotify` skips
 * polls that already have it, and `createNotification` ignores duplicates, so
 * a re-run (or a crash halfway) never delivers the same notification twice.
 */
export async function notifyExpiredPolls(env: NotifyEnv, limit = 20): Promise<number> {
  const expired = await listPollsToNotify(env.DB, limit);
  for (const poll of expired) {
    try {
      const createdAt = new Date().toISOString();
      for (const voterId of await listLocalPollVoters(env.DB, poll.pollId)) {
        await notify(env, {
          id: generateId(),
          type: "poll",
          accountId: poll.actorId,
          targetAccountId: voterId,
          objectId: poll.objectId,
          read: false,
          createdAt,
        });
      }
      await notify(env, {
        id: generateId(),
        type: "poll",
        accountId: poll.actorId,
        targetAccountId: poll.actorId,
        objectId: poll.objectId,
        read: false,
        createdAt,
      });
    } catch { /* one poll must not stop the pass */ }
  }
  return expired.length;
}

/**
 * Fetch a remote poll's current document and apply its counts, throttled per
 * poll in KV. Votes are addressed to the poll author only, so this is the only
 * way a timeline/viewer sees the total remote votes.
 */
export async function refreshRemotePoll(
  bindings: RefreshBindings,
  poll: LocalPoll,
  object: LocalObject,
  signer?: { id: string; privateKeyPem?: string | null }
): Promise<boolean> {
  if (object.local) return false;
  if (new Date(poll.expiresAt) <= new Date()) return false;
  const key = `poll:refresh:${poll.id}`;
  try {
    if (await bindings.KV.get(key)) return false;
    await bindings.KV.put(key, "1", { expirationTtl: 300 });
  } catch { /* KV is best-effort: still refresh */ }
  try {
    const question = await fetchRemoteObject(
      object.id,
      signer ? `${signer.id}#main-key` : undefined,
      signer?.privateKeyPem ?? undefined
    );
    const q = question as Record<string, unknown> | null;
    if (!q || String(q.type ?? "").split("/").pop() !== "Question") return false;
    return await refreshPollFromQuestion(bindings.DB, q);
  } catch {
    return false;
  }
}

function questionChoices(question: Record<string, unknown>): Record<string, unknown>[] {
  const single = Array.isArray(question.oneOf) ? question.oneOf : [];
  const multi = Array.isArray(question.anyOf) ? question.anyOf : [];
  return (single.length > 0 ? single : multi) as Record<string, unknown>[];
}

/** True when every choice carries a `replies.totalItems` count. */
export function hasVoteCounts(question: Record<string, unknown>): boolean {
  const choices = questionChoices(question);
  if (choices.length === 0) return false;
  return choices.every((choice) => {
    const replies = choice?.replies as { totalItems?: unknown } | undefined;
    return replies == null || typeof replies.totalItems === "number";
  });
}

/**
 * Render a local poll on an AP Note as a Mastodon-style `Question`: the choices
 * with their current per-choice counts, the deadline and the voter count. Every
 * path that serves a local status must apply it — Mastodon's NoteSerializer
 * always serializes a poll status as a Question, and peers re-fetch the object
 * URL to refresh the counts (exactly what `refreshRemotePoll` does for remote
 * polls here).
 */
export function applyPollToNote(note: APNote, poll: LocalPoll, options: LocalPollOption[]): void {
  if (options.length === 0) return;
  const target = note as Record<string, unknown>;
  const choices = options.map((option) => ({
    type: "Note",
    name: option.title,
    replies: { type: "Collection", totalItems: Number(option.votesCount ?? 0) },
  }));
  target.type = "Question";
  if (poll.multiple) target.anyOf = choices;
  else target.oneOf = choices;
  // ISO-8601, like every other timestamp we federate: the row may still hold
  // SQLite's `YYYY-MM-DD HH:MM:SS` and strict parsers (Rust `time`) reject it.
  const expiresIso = isoTimestamp(poll.expiresAt);
  target.endTime = expiresIso;
  // Mastodon marks a finished poll with `closed` (and keeps `endTime`). The
  // value is normalized too — emitting the stored string could federate a
  // non-ISO timestamp, and the expiry comparison parses the normalized ISO
  // (a DB-shape string would be read as local time).
  if (new Date(expiresIso) <= new Date()) target.closed = expiresIso;
  if (poll.votersCount > 0) target.votersCount = poll.votersCount;
}

/** Fetch the note's poll (if any) and render it as a Question. */
export async function applyPollToNoteFromDb(db: D1Database, note: APNote): Promise<void> {
  const polls = await getPollsByObjectIds(db, [note.id]);
  const entry = polls.get(note.id);
  if (entry) applyPollToNote(note, entry.poll, entry.options);
}

/**
 * Apply the origin's counts to the cached poll. Returns false when the object
 * has no local poll row or the shape doesn't match (never clobbers counts with
 * a partial document).
 */
export async function refreshPollFromQuestion(
  db: D1Database,
  question: Record<string, unknown>
): Promise<boolean> {
  const objectId = typeof question.id === "string" ? question.id : null;
  if (!objectId) return false;
  const poll = await getPollByObjectId(db, objectId);
  if (!poll) return false;

  const choices = questionChoices(question);
  const options = await getPollOptions(db, poll.id);
  if (choices.length === 0 || choices.length !== options.length) return false;

  const counts = choices.map((choice) => {
    const replies = choice?.replies as { totalItems?: unknown } | undefined;
    const n = Number(replies?.totalItems ?? 0);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
  const voters = Number(question.votersCount);
  const total = counts.reduce((sum, n) => sum + n, 0);
  const nextVoters = Number.isFinite(voters) && voters > 0 ? voters : total;

  // Skip the write when nothing changed. The refresh cron re-reads every live
  // remote poll every few minutes and used to rewrite all option rows plus the
  // poll row even with identical counts — tens of thousands of D1 row writes a
  // day on a relay-fed instance, where vote totals rarely move between
  // refreshes. A real change still writes: votes also arrive pushed as
  // Update{Question}, and both paths land here.
  const unchanged =
    options.length === counts.length &&
    options.every((opt, i) => Number(opt.votesCount ?? 0) === counts[i]) &&
    Number(poll.votesCount ?? 0) === total &&
    Number(poll.votersCount ?? 0) === nextVoters;
  if (unchanged) return true;

  await setPollVoteCounts(db, poll.id, counts, nextVoters);
  return true;
}
