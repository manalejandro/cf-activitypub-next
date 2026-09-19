/**
 * Refresh a locally cached poll from an ActivityPub `Question`.
 *
 * Remote vote counts only reach us through the origin's document (votes are
 * addressed to the poll author, not broadcast), so the poll detail refreshes
 * it on access and `Update{Question}` activities apply it too.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { getPollByObjectId, getPollOptions, setPollVoteCounts } from "@/lib/db";

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
