/**
 * Refresh a locally cached poll from an ActivityPub `Question`.
 *
 * Remote vote counts only reach us through the origin's document (votes are
 * addressed to the poll author, not broadcast), so the poll detail refreshes
 * it on access and `Update{Question}` activities apply it too.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { getPollByObjectId, getPollOptions, setPollVoteCounts } from "@/lib/db";
import { fetchRemoteObject } from "@/lib/activitypub/federation";
import type { LocalObject, LocalPoll } from "@/lib/types";

interface RefreshBindings {
  DB: D1Database;
  KV: { get(key: string): Promise<string | null>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> };
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

  await setPollVoteCounts(db, poll.id, counts, Number.isFinite(voters) && voters > 0 ? voters : null);
  return true;
}
