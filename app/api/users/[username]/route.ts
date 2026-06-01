import { type NextRequest } from "next/server";
import { getCloudflareContext, activityJson, notFound } from "@/lib/cf";
import { getActorByUsername, getActorFields } from "@/lib/db";
import { buildActor } from "@/lib/activitypub/utils";

// GET /users/:username
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { username } = await params;
  const domain = new URL(request.url).hostname;

  const accept = request.headers.get("Accept") ?? "";
  // Redirect HTML requests to profile page
  if (accept.includes("text/html") && !accept.includes("application/activity+json")) {
    return Response.redirect(`https://${domain}/@${username}`, 302);
  }

  const actor = await getActorByUsername(env.DB, username, domain);
  if (!actor || !actor.isLocal) return notFound("Actor not found");

  const fields = await getActorFields(env.DB, actor.id);
  const baseUrl = `https://${domain}`;
  const apActor = buildActor(baseUrl, actor.username, {
    displayName: actor.displayName ?? undefined,
    summary: actor.summary ?? undefined,
    avatarUrl: actor.avatarUrl,
    headerUrl: actor.headerUrl,
    publicKeyPem: actor.publicKeyPem,
    manuallyApprovesFollowers: actor.manuallyApprovesFollowers,
    discoverable: actor.discoverable,
    isBot: actor.isBot,
    published: actor.createdAt,
    fields: fields.map((f) => ({ name: f.name, value: f.value })),
  });

  return activityJson(apActor);
}
