import { type NextRequest } from "next/server";
import { getCloudflareContext } from "@/lib/cf";

// GET /api/media/[...key] — Serve a file from R2.
//
// Videos must be streamed, never buffered: a full-body read of a 40 MB clip
// exceeds the Worker memory budget, and browsers need byte ranges to seek and
// to play without downloading the whole file first. Metadata is read with
// `R2.head` so HEAD/304/416 responses never touch the body.

interface ByteRange {
  offset: number;
  length: number;
}

/** Parse a single-range `Range: bytes=…` header against the object size. */
function parseRange(header: string | null, size: number): ByteRange | null | "invalid" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "invalid";
  const [, startRaw, endRaw] = match;
  if (startRaw === "" && endRaw === "") return "invalid";

  if (startRaw === "") {
    // Suffix range: the last N bytes.
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }

  const start = Number(startRaw);
  if (!Number.isFinite(start) || start >= size) return "invalid";
  const end = endRaw === "" ? size - 1 : Math.min(Number(endRaw), size - 1);
  if (!Number.isFinite(end) || end < start) return "invalid";
  return { offset: start, length: end - start + 1 };
}

function baseHeaders(object: { writeHttpMetadata(headers: Headers): void; httpEtag: string; size: number }): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(object.size));
  return headers;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ key: string[] }> }
): Promise<Response> {
  const { key } = await params;
  const r2Key = key.join("/");
  const { env } = getCloudflareContext();

  // Metadata first: HEAD, 304 and 416 answers never read the object body.
  const head = await env.R2.head(r2Key);
  if (!head) return new Response("Not found", { status: 404 });

  const headers = baseHeaders(head);

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch === head.httpEtag) {
    headers.delete("Content-Length");
    return new Response(null, { status: 304, headers });
  }

  const range = parseRange(request.headers.get("range"), head.size);
  if (range === "invalid") {
    headers.set("Content-Range", `bytes */${head.size}`);
    headers.delete("Content-Length");
    return new Response(null, { status: 416, headers });
  }

  const object = range
    ? await env.R2.get(r2Key, { range: { offset: range.offset, length: range.length } })
    : await env.R2.get(r2Key);
  if (!object) return new Response("Not found", { status: 404 });

  if (range) {
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
    headers.set("Content-Length", String(range.length));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { status: 200, headers });
}

export async function HEAD(
  request: NextRequest,
  context: { params: Promise<{ key: string[] }> }
): Promise<Response> {
  return GET(request, context);
}
