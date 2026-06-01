import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import { getPollById, getPollOptions, getPollVotesByActor, createPollVotes } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializePoll } from "@/lib/mastodon/serializers";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const poll = await getPollById(env.DB, id);
  if (!poll) return notFound("Poll not found");

  if (new Date(poll.expiresAt) < new Date()) {
    return json({ error: "Poll has expired" }, 422);
  }

  const existingVotes = await getPollVotesByActor(env.DB, id, actor.id);
  if (existingVotes.length > 0) {
    return json({ error: "Already voted" }, 422);
  }

  const body = (await request.json()) as { choices?: number[] };
  const choices = (body.choices ?? []).filter((c) => typeof c === "number" && Number.isInteger(c) && c >= 0);

  if (choices.length === 0) return json({ error: "No choices provided" }, 422);

  const options = await getPollOptions(env.DB, id);
  if (!poll.multiple && choices.length > 1) {
    return json({ error: "This poll does not allow multiple choices" }, 422);
  }
  const validChoices = choices.filter((c) => c < options.length);
  if (validChoices.length === 0) return json({ error: "Invalid choices" }, 422);

  await createPollVotes(env.DB, id, actor.id, validChoices);

  const updatedPoll = await getPollById(env.DB, id);
  const updatedOptions = await getPollOptions(env.DB, id);
  const ownVotes = await getPollVotesByActor(env.DB, id, actor.id);

  return json(serializePoll(updatedPoll!, updatedOptions, true, ownVotes));
}
