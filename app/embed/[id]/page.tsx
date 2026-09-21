import { notFound } from "next/navigation";
import { getCloudflareContext, getBaseUrl } from "@/lib/cf";
import { getActorById, getObjectById } from "@/lib/db";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import { sanitizeFediverseHtml } from "@/lib/activitypub/sanitize";

/**
 * Minimal, iframe-friendly status view used by the oEmbed `rich` HTML.
 * Public/unlisted only; rendered server-side (no app shell, no auth).
 */
export default async function EmbedStatusPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { env } = getCloudflareContext();
  const base = getBaseUrl(env);
  const host = new URL(base).hostname;

  const obj = await getObjectById(env.DB, decodeStatusId(decodeURIComponent(id), host));
  if (!obj || obj.visibility === "private" || obj.visibility === "direct") notFound();
  const author = await getActorById(env.DB, obj.actorId);
  if (!author || author.suspended || author.silenced) notFound();

  const content = sanitizeFediverseHtml(obj.content ?? "") ?? "";
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "0.9rem", background: "#fff", color: "#111" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
        {author.avatarUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={author.avatarCacheUrl ?? author.avatarUrl} alt="" width={32} height={32} style={{ borderRadius: "50%", objectFit: "cover" }} />
        )}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{author.displayName || author.username}</div>
          <a href={`${base}/statuses/${encodeURIComponent(id)}`} target="_blank" rel="noopener noreferrer" style={{ color: "#666", fontSize: "0.78rem", textDecoration: "none" }}>
            @{author.username} · {new Date(obj.published).toLocaleDateString()}
          </a>
        </div>
      </div>
      <div style={{ fontSize: "0.9rem", lineHeight: 1.5, overflowWrap: "break-word" }} dangerouslySetInnerHTML={{ __html: content }} />
      <a href={`${base}/statuses/${encodeURIComponent(id)}`} target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", marginTop: "0.6rem", fontSize: "0.78rem", color: "#666" }}>
        View on {(env as unknown as Record<string, string>).INSTANCE_TITLE ?? host}
      </a>
    </main>
  );
}
