/**
 * Media attachments of a scheduled status.
 *
 * Until the publish cron links them, a scheduled post's uploads exist only as
 * `pending_media:<id>` KV reservations (TTL extended to 30 days at schedule
 * time), so the scheduled-status endpoints resolve their attachment entities
 * from there — the composer needs real URLs to render (and edit) the reserved
 * media of a schedule.
 */

export interface ScheduledMediaAttachment {
  id: string;
  type: string;
  url: string;
  preview_url: string;
  description: string | null;
  mime_type: string | null;
  meta: { original?: { size?: string } };
}

/** Minimal KV surface (structural on purpose: shared helpers must type-check in every tsconfig). */
interface KvReader {
  get(key: string): Promise<string | null>;
}

/** Expired, malformed or somebody else's reservations are skipped. */
export async function scheduledMediaAttachments(
  kv: KvReader,
  mediaIdsRaw: string | null,
  ownerId: string
): Promise<ScheduledMediaAttachment[]> {
  if (!mediaIdsRaw) return [];
  let mediaIds: string[] = [];
  try {
    const parsed = JSON.parse(mediaIdsRaw) as unknown;
    mediaIds = Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
  const out: ScheduledMediaAttachment[] = [];
  for (const mediaId of mediaIds) {
    const raw = await kv.get(`pending_media:${mediaId}`).catch(() => null);
    if (!raw) continue;
    try {
      const pending = JSON.parse(raw) as {
        actorId?: string;
        type?: string;
        url?: string;
        description?: string | null;
        mimeType?: string | null;
        fileSize?: number | null;
      };
      if (pending.actorId && pending.actorId !== ownerId) continue;
      if (!pending.url) continue;
      out.push({
        id: mediaId,
        type: pending.type ?? "unknown",
        url: pending.url,
        preview_url: pending.url,
        description: pending.description ?? null,
        mime_type: pending.mimeType ?? null,
        meta:
          typeof pending.fileSize === "number" && pending.fileSize > 0
            ? { original: { size: String(pending.fileSize) } }
            : {},
      });
    } catch { /* malformed entry — skip */ }
  }
  return out;
}
