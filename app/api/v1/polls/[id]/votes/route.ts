import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import { canViewStatus, getObjectById, getPollById, getPollOptions, getPollVotesByActor, createPollVotes, isAcceptedFollower } from "@/lib/db";
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
  // A poll can only be voted while its underlying status is visible.
  const pollObject = await getObjectById(env.DB, poll.objectId);
  if (!pollObject) return notFound("Poll not found");
  const isFollowing = pollObject.actorId === actor.id ? false : await isAcceptedFollower(env.DB, actor.id, pollObject.actorId);
  if (!canViewStatus(pollObject, actor.id, isFollowing)) return notFound("Poll not found");

  if (new Date(poll.expiresAt) < new Date()) {
    return json({ error: "Poll has expired" }, 422);
  }

  const existingVotes = await getPollVotesByActor(env.DB, id, actor.id);
  if (existingVotes.length > 0) {
    return json({ error: "Already voted" }, 422);
  }

  const contentType = request.headers.get("Content-Type") ?? "";
  let rawChoices: unknown;
  if (contentType.includes("application/json")) {
    const body = (await request.json()) as { choices?: unknown };
    rawChoices = body.choices;
  } else {
    const form = await request.formData();
    const choices = form.getAll("choices[]");
    rawChoices = choices.length > 0
      ? choices.map((c) => Number(String(c)))
      : (() => {
          const single = form.get("choices");
          return single != null ? [Number(String(single))] : undefined;
        })();
  }
  const choices = (Array.isArray(rawChoices) ? rawChoices : []).filter((c): c is number => typeof c === "number" && Number.isInteger(c) && c >= 0);

  if (choices.length === 0) return json({ error: "No choices provided" }, 422);

  const options = await getPollOptions(env.DB, id);
  if (!poll.multiple && choices.length > 1) {
    return json({ error: "This poll does not allow multiple choices" }, 422);
  }
  const validChoices = choices.filter((c) => c < options.length);
  if (validChoices.length !== choices.length) return json({ error: "Invalid choices" }, 422);

  await createPollVotes(env.DB, id, actor.id, validChoices);

  const updatedPoll = await getPollById(env.DB, id);
  const updatedOptions = await getPollOptions(env.DB, id);
  const ownVotes = await getPollVotesByActor(env.DB, id, actor.id);

  return json(serializePoll(updatedPoll!, updatedOptions, true, ownVotes));
}
