/**
 * File name for a media download.
 *
 * Media is served from `/api/media/<r2-key>`, so a plain `download` link saves
 * the bucket name (`cache/media/<sha256>.jpg`, `media/<user>/<uuid>.png`).
 * The name is the one the user gave the resource when publishing it — the
 * attachment's description (alt text) — with the file name of their own upload
 * as a second option, and the bucket name only as the last resort.
 *
 * Nothing here touches the media cache, its R2 keys or the served URLs.
 */

export interface DownloadableMedia {
  url: string;
  description?: string | null;
}

function lastSegment(url: string): string {
  const path = url.split(/[?#]/)[0];
  const segment = path.split("/").filter(Boolean).pop() ?? "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** A name worth saving as: it must carry an extension and not be a bare hash. */
function isRealFileName(name: string): boolean {
  if (!/\.[A-Za-z0-9]{2,5}$/.test(name)) return false;
  const base = name.replace(/\.[^.]+$/, "");
  if (base.length < 3 || base.length > 120) return false;
  return !/^[0-9a-f]{16,}$/i.test(base);
}

/** Our own uploads keep the file name the user chose: `media/<user>/<uuid>-<name>`. */
function uploadedName(url: string): string | null {
  const match = /\/api\/media\/media\/[^/]+\/[0-9a-f-]{32,36}-([^/?#]+)/i.exec(url);
  if (!match) return null;
  let name = match[1];
  try {
    name = decodeURIComponent(name);
  } catch { /* keep the raw segment */ }
  return isRealFileName(name) ? name : null;
}

function extensionOf(served: string): string {
  const match = /\.[A-Za-z0-9]{2,5}$/.exec(served);
  return match ? match[0].toLowerCase() : "";
}

/** Trim path-hostile characters and length from an alt text. */
function sanitizeDescription(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export function mediaDownloadName(media: DownloadableMedia): string | undefined {
  const served = lastSegment(media.url);
  const extension = extensionOf(served);

  const description = sanitizeDescription(media.description ?? "");
  if (description) {
    // A description that already ends in the file's extension is kept as-is.
    return description.toLowerCase().endsWith(extension) ? description : `${description}${extension}`;
  }

  const uploaded = uploadedName(media.url);
  if (uploaded) return uploaded;

  return served || undefined;
}

/**
 * Basename safe to embed in an R2 upload key (`media/<user>/<uuid>-<name>`).
 * The name is client-controlled and travels inside URLs (the serve path and
 * `uploadedName` above): path separators, control characters and whitespace
 * are stripped, a conservative charset is enforced and the length bounded.
 */
export function safeUploadName(rawName: string | null | undefined, fallback = "upload.bin"): string {
  const base = (rawName ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 100);
  return cleaned || fallback;
}

/** Extension for an R2 key, derived from the upload's file name: `[a-z0-9]{1,10}`. */
export function safeUploadExt(rawName: string | null | undefined, fallback = "bin"): string {
  const base = (rawName ?? "").split(/[\\/]/).pop() ?? "";
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  const cleaned = ext.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10);
  return cleaned || fallback;
}
