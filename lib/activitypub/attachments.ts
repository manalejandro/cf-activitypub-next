/**
 * Stored attachment → ActivityPub object, in one place.
 *
 * The mapping follows Mastodon's own convention (see its API `MediaAttachment`
 * enum and AP issue #12639): `image/*` → `Image`, `video/*` → `Video`,
 * `audio/*` → `Audio` and **everything else → `Document` carrying the real
 * `mediaType`**. A PDF, a plain-text file or any future type therefore arrives
 * at a peer as `Document` + `mediaType: application/pdf`, which Mastodon's
 * parser keeps (`file_content_type`) and stores as its `unknown` attachment
 * type — the one every client renders as a download link instead of a player.
 *
 * `name` is the alt text/description, `blurhash`, `width` and `height` are only
 * meaningful for media (a document has none) and `sensitive` rides along when
 * the uploader marked it, mirroring the per-status flag.
 */

import type { APAttachment, LocalAttachment } from "@/lib/types";

export function toAPAttachment(att: LocalAttachment): APAttachment {
  const mimeType = att.mimeType ?? "application/octet-stream";
  let type: APAttachment["type"] = "Document";
  if (mimeType.startsWith("image/")) type = "Image";
  else if (mimeType.startsWith("video/")) type = "Video";
  else if (mimeType.startsWith("audio/")) type = "Audio";
  return {
    id: att.url,
    type,
    mediaType: mimeType,
    url: att.url,
    ...(att.description ? { name: att.description } : {}),
    ...(att.blurhash ? { blurhash: att.blurhash } : {}),
    ...(att.width != null ? { width: att.width } : {}),
    ...(att.height != null ? { height: att.height } : {}),
    ...(att.sensitive ? { sensitive: true } : {}),
  };
}
