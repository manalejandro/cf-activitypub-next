import type { Metadata } from "next";
import { getCloudflareContext, getBaseUrl } from "@/lib/cf";
import { getActorById, getObjectById } from "@/lib/db";
import { decodeStatusId, encodeStatusId } from "@/lib/mastodon/statusId";

/**
 * Server-side metadata for status permalinks: OpenGraph/Twitter tags plus the
 * oEmbed discovery link, so Mastodon (and our own crawler) build a preview card
 * when the URL is pasted. Private/direct statuses expose nothing.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  try {
    const { id } = await params;
    const { env } = getCloudflareContext();
    const base = getBaseUrl(env);
    const host = new URL(base).hostname;
    const obj = await getObjectById(env.DB, decodeStatusId(decodeURIComponent(id), host));
    if (!obj || obj.visibility === "private" || obj.visibility === "direct") return {};
    const author = await getActorById(env.DB, obj.actorId);
    if (!author || author.suspended || author.silenced) return {};

    const canonical = `${base}/statuses/${encodeStatusId(obj.id, obj.local)}`;
    const title = `${author.displayName || author.username} (@${author.username})`;
    const description = (obj.content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    const image = author.avatarCacheUrl ?? author.avatarUrl ?? undefined;
    return {
      title,
      description: description || title,
      alternates: {
        canonical,
        types: {
          "application/json+oembed": [{ url: `${base}/api/oembed?url=${encodeURIComponent(canonical)}` }],
        },
      },
      openGraph: {
        type: "article",
        title,
        description: description || title,
        url: canonical,
        ...(image ? { images: [{ url: image }] } : {}),
      },
      twitter: {
        card: "summary",
        title,
        description: description || title,
        ...(image ? { images: [image] } : {}),
      },
    };
  } catch {
    return {};
  }
}

export default function StatusLayout({ children }: { children: React.ReactNode }) {
  return children;
}
