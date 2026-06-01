import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getPollById, getPollOptions, getPollVotesByActor } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializePoll } from "@/lib/mastodon/serializers";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;

  const poll = await getPollById(env.DB, id);
  if (!poll) return notFound("Poll not found");

  const options = await getPollOptions(env.DB, id);
  const actor = await getAuthenticatedActor(request, env.DB);
  const ownVotes = actor ? await getPollVotesByActor(env.DB, id, actor.id) : [];

  return json(serializePoll(poll, options, ownVotes.length > 0, ownVotes));
}
