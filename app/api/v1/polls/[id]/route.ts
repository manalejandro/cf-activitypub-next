import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getPollById, getPollOptions, getPollVotesByActor, getObjectById, getActorById } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializePoll } from "@/lib/mastodon/serializers";
import { refreshRemotePoll } from "@/lib/activitypub/polls";
import { generateId } from "@/lib/activitypub/utils";
import { notify } from "@/lib/notify";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;

  let poll = await getPollById(env.DB, id);
  if (!poll) return notFound("Poll not found");

  const obj = await getObjectById(env.DB, poll.objectId);
  const actor = await getAuthenticatedActor(request, env.DB);

  // Remote polls are refreshed from the origin when the detail is opened:
  // votes are addressed to the poll author only, so the origin's document is
  // the only place with the current counts. Throttled per poll.
  if (obj && !obj.local) {
    const refreshed = await refreshRemotePoll(
      { DB: env.DB, KV: env.KV },
      poll,
      obj,
      actor ? { id: actor.id, privateKeyPem: actor.privateKeyPem } : undefined
    );
    if (refreshed) poll = (await getPollById(env.DB, id)) ?? poll;
  }

  const options = await getPollOptions(env.DB, id);
  const ownVotes = actor ? await getPollVotesByActor(env.DB, id, actor.id) : [];

  // If poll has expired, notify the status author (only once via INSERT OR IGNORE)
  if (poll.expiresAt && new Date(poll.expiresAt) <= new Date()) {
    if (obj) {
      const author = await getActorById(env.DB, obj.actorId);
      if (author) {
        await notify(env, {
          id: generateId(),
          type: "poll",
          accountId: obj.actorId,
          targetAccountId: obj.actorId,
          objectId: obj.id,
          read: false,
          createdAt: new Date().toISOString(),
        });
      }
    }
  }

  return json(serializePoll(poll, options, ownVotes.length > 0, ownVotes));
}
