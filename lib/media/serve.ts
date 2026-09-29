/**
 * R2 media serving shared by the Next route (`app/api/media/[...key]`) and the
 * worker entry (`src/worker.ts`).
 *
 * The worker intercepts `/api/media/…` **before** OpenNext on purpose: the
 * framework appends `Vary: rsc, next-router-state-tree, next-router-prefetch,
 * next-router-segment-prefetch` to every app response and Cloudflare only
 * honours `Vary: Accept-Encoding` when caching, so with the framework header
 * (and the `mp4`/`jpg`/… extension rules) the CDN skipped the cache and every
 * video range request streamed R2 → Worker → client. Browsers cancel a buffered
 * stream (that is normal for `<video>`), which floods the Worker logs with
 * "Network connection lost" and the runtime's "code had hung" cancellation.
 * Serving the bytes ourselves keeps `Vary: Accept-Encoding`, so the CDN caches
 * the object and later ranges are answered from the edge.
 */

interface R2HeadLike {
  writeHttpMetadata(headers: Headers): void;
  httpEtag: string;
  size: number;
}

interface R2BodyLike extends R2HeadLike {
  body?: ReadableStream | null;
}

/** Minimal R2 surface used here (keeps the Next route and worker decoupled). */
export interface MediaBucket {
  head(key: string): Promise<R2HeadLike | null>;
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<R2BodyLike | null>;
}

export interface ByteRange {
  offset: number;
  length: number;
}

/** CORS for media: cross-origin clients fetch ranges, so `Range` must be
 *  allowed and the range headers readable (`<video>` seeking in web clients). */
export const MEDIA_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, Range, If-None-Match, If-Range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, ETag",
  "Access-Control-Max-Age": "86400",
};

/**
 * Parse a single-range `Range: bytes=…` header against the object size.
 *
 * Returns `null` when the header must be ignored — absent, malformed or a
 * multi-range request (RFC 9110 lets a server answer 200 with the whole body,
 * which is what video players expect; the previous 416 broke Safari, whose
 * media stack sends multi-range probes). `"unsatisfiable"` is a valid single
 * range past the end, which is a real 416.
 */
export function parseRangeHeader(header: string | null, size: number): ByteRange | null | "unsatisfiable" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startRaw, endRaw] = match;
  if (startRaw === "" && endRaw === "") return null;

  if (startRaw === "") {
    // Suffix range: the last N bytes.
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }

  const start = Number(startRaw);
  if (!Number.isFinite(start)) return null;
  if (start >= size) return "unsatisfiable";
  const end = endRaw === "" ? size - 1 : Math.min(Number(endRaw), size - 1);
  if (!Number.isFinite(end) || end < start) return null;
  return { offset: start, length: end - start + 1 };
}

function baseHeaders(object: R2HeadLike): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  for (const [key, value] of Object.entries(MEDIA_CORS_HEADERS)) headers.set(key, value);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  // Content-addressed keys and per-upload keys, both immutable; only the
  // encoding changes the bytes, so the CDN may cache per encoding.
  headers.set("Vary", "Accept-Encoding");
  headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(object.size));
  return headers;
}

/**
 * Serve one R2 object: HEAD/304/416 answers never read the body, ranges stream
 * the requested slice, and the whole object streams with a known length.
 */
export async function serveMediaObject(
  request: Request,
  bucket: MediaBucket,
  r2Key: string
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...MEDIA_CORS_HEADERS } });
  }

  // Metadata first: HEAD, 304 and 416 answers never touch the object body.
  const head = await bucket.head(r2Key);
  if (!head) return new Response("Not found", { status: 404, headers: { ...MEDIA_CORS_HEADERS } });

  const headers = baseHeaders(head);

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch === head.httpEtag) {
    headers.delete("Content-Length");
    return new Response(null, { status: 304, headers });
  }

  const range = parseRangeHeader(request.headers.get("range"), head.size);
  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${head.size}`);
    headers.delete("Content-Length");
    return new Response(null, { status: 416, headers });
  }

  const object = range
    ? await bucket.get(r2Key, { range: { offset: range.offset, length: range.length } })
    : await bucket.get(r2Key);
  if (!object) return new Response("Not found", { status: 404, headers: { ...MEDIA_CORS_HEADERS } });

  if (range) {
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
    headers.set("Content-Length", String(range.length));
    return new Response(object.body ?? null, { status: 206, headers });
  }

  headers.set("Content-Length", String(object.size));
  return new Response(object.body ?? null, { status: 200, headers });
}
