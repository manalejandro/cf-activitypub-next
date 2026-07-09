import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getActorById } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const { id } = await params;
  const actor = await getActorById(env.DB, id);
  if (!actor) return notFound();

  return json({
    id: actor.id,
    username: actor.username,
    domain: actor.domain,
    created_at: actor.createdAt,
    email: actor.email,
    ip: null,
    role: { id: "1", name: "Admin", color: "" },
    confirmed: actor.emailVerified,
    suspended: false,
    silenced: false,
    disabled: false,
    approved: true,
    account: serializeAccount(actor, domain),
  });
}
