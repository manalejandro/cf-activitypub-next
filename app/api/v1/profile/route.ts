import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorFields } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const fields = await getActorFields(env.DB, actor.id);
  const acct = serializeAccount(actor, domain, { isCurrentUser: true, fields });

  return json({
    id: acct.id,
    display_name: acct.display_name,
    note: acct.note,
    fields: acct.fields,
    avatar: acct.avatar,
    avatar_static: acct.avatar_static,
    avatar_description: "",
    header: acct.header,
    header_static: acct.header_static,
    header_description: "",
    locked: acct.locked,
    bot: acct.bot,
    hide_collections: false,
    discoverable: acct.discoverable,
    indexable: acct.indexable,
    show_media: true,
    show_media_replies: true,
    show_featured: true,
    attribution_domains: [],
    featured_tags: [],
  });
}