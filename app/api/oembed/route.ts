import { type NextRequest } from "next/server";
import { getCloudflareContext, getBaseUrl, json } from "@/lib/cf";
import { getActorById, getObjectById } from "@/lib/db";
import { decodeStatusId, encodeStatusId } from "@/lib/mastodon/statusId";

/**
 * oEmbed provider for local statuses (Mastodon's `/api/oembed`).
 *
 * Any public/unlisted status can be embedded: the returned `rich` HTML points
 * at our minimal `/embed/<id>` page. Private/direct statuses are not
 * embeddable.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const base = getBaseUrl(env);
  const host = new URL(base).hostname;
  const target = new URL(request.url).searchParams.get("url") ?? "";
  if (!target) return json({ error: "url is required" }, 400);

  let statusId: string;
  try {
    const parsed = new URL(target);
    if (parsed.hostname !== host) return json({ error: "Not found" }, 404);
    const match = parsed.pathname.match(/\/(?:statuses|@[^/]+)\/([^/?#]+)/);
    if (!match) return json({ error: "Not found" }, 404);
    statusId = decodeURIComponent(match[1]);
  } catch {
    return json({ error: "Invalid url" }, 404);
  }

  const obj = await getObjectById(env.DB, decodeStatusId(statusId, host));
  if (!obj || obj.visibility === "private" || obj.visibility === "direct") {
    return json({ error: "Not found" }, 404);
  }
  const author = await getActorById(env.DB, obj.actorId);
  if (!author || author.suspended || author.silenced) return json({ error: "Not found" }, 404);

  const canonical = `${base}/statuses/${encodeStatusId(obj.id, obj.local)}`;
  const embed = `${base}/embed/${encodeStatusId(obj.id, obj.local)}`;
  return json({
    version: "1.0",
    type: "rich",
    title: `${author.displayName || author.username}: ${(obj.content ?? "").replace(/<[^>]+>/g, " ").trim().slice(0, 120)}`,
    author_name: author.displayName || author.username,
    author_url: `${base}/@${author.username}`,
    provider_name: (env as unknown as Record<string, string>).INSTANCE_TITLE ?? "ActivityPub",
    provider_url: base,
    url: canonical,
    html: `<iframe src="${embed}" width="400" height="320" style="border:0;max-width:100%" allowfullscreen sandbox="allow-scripts allow-same-origin allow-popups"></iframe>`,
  });
}
