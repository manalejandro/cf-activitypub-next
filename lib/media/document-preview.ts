/**
 * What the document viewer can render, and how to read it without blowing up the
 * tab: PDFs go to the browser's own viewer (an iframe), text is fetched and
 * shown as text — never as HTML — and anything else is a download.
 */

/** First bytes of a text file the viewer renders (`Range` gets them in one small request). */
export const DOCUMENT_PREVIEW_MAX_BYTES = 256 * 1024;

export type DocumentPreviewKind = "pdf" | "text" | "none";

/**
 * The kind comes from the MIME when the caller has one (our own uploads carry
 * it) and from the URL extension otherwise — cached remote documents keep their
 * extension in the storage key, and the REST attachment entity has no MIME
 * field (Mastodon's shape), so the URL is usually all we have.
 */
export function documentPreviewKind(url: string | null | undefined, mimeType?: string | null): DocumentPreviewKind {
  const mime = (mimeType ?? "").toLowerCase().split(";")[0].trim();
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("text/")) return "text";
  const path = (url ?? "").toLowerCase().split(/[?#]/)[0];
  if (path.endsWith(".pdf")) return "pdf";
  if (/\.(txt|md|markdown|csv|log|json|xml|ya?ml)$/.test(path)) return "text";
  return "none";
}

/**
 * Where the viewer should load the file from. Our own media path is served by
 * whichever host serves the app, so an absolute URL pointing at it (the stored
 * `https://INSTANCE_URL/api/media/...`) becomes a **relative** one: that keeps
 * the fetch inside our CSP `connect-src 'self'`, lets the browser frame it
 * without the origin's `X-Frame-Options`, and — because `download` is ignored
 * on cross-origin URLs — makes the download button actually download. Remote
 * (uncached) files keep their absolute URL.
 */
export function documentPreviewUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith("/api/media/")) return `${parsed.pathname}${parsed.search}`;
  } catch {
    // Relative or malformed: use it as it is.
  }
  return url;
}

export interface CappedText {
  text: string;
  /** The file is longer than the cap: only its beginning is shown. */
  truncated: boolean;
  /** Total size when the response reported it (`content-range`), else null. */
  totalBytes: number | null;
}

/**
 * Read at most `maxBytes` of a text response. The media serve path answers
 * `Range` with a 206 and a `content-range`, so a 32 MB log costs one 256 KB
 * request; when the origin ignores the range the body is walked through a
 * reader that stops at the cap and cancels the rest — buffering the whole file
 * in the tab would freeze the page.
 */
export async function readCappedText(
  response: Response,
  maxBytes = DOCUMENT_PREVIEW_MAX_BYTES
): Promise<CappedText> {
  let totalBytes: number | null = null;
  let truncated = false;

  const contentRange = response.headers.get("content-range");
  const reported = contentRange?.match(/bytes\s+\d+-\d+\/(\d+)/i);
  if (reported) {
    totalBytes = Number(reported[1]);
    truncated = totalBytes > maxBytes;
  }

  const body = response.body;
  if (!body?.getReader) {
    const text = await response.text();
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > maxBytes) {
      return { text: new TextDecoder().decode(bytes.subarray(0, maxBytes)), truncated: true, totalBytes };
    }
    return { text, truncated, totalBytes };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const remaining = maxBytes - size;
      if (value.byteLength >= remaining) {
        chunks.push(value.subarray(0, remaining));
        size += remaining;
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    // A cancelled/aborted stream still has what was read so far.
  }

  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    text: new TextDecoder("utf-8").decode(merged),
    truncated: truncated || (totalBytes !== null && totalBytes > maxBytes),
    totalBytes: totalBytes ?? (truncated ? null : size),
  };
}
