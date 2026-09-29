import { type NextRequest } from "next/server";
import { getCloudflareContext } from "@/lib/cf";
import { serveMediaObject } from "@/lib/media/serve";

// GET /api/media/[...key] — Serve a file from R2.
//
// Production requests are intercepted in `src/worker.ts` before OpenNext (so
// the response carries no Next.js `Vary` header and the CDN can cache it); this
// route keeps plain `next dev` and any non-intercepted path working. Videos are
// always streamed (never buffered) and byte ranges are honoured so browsers can
// seek without downloading the whole file: see `lib/media/serve.ts`.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ key: string[] }> }
): Promise<Response> {
  const { key } = await params;
  const { env } = getCloudflareContext();
  return serveMediaObject(request, env.R2, key.join("/"));
}

export async function HEAD(
  request: NextRequest,
  context: { params: Promise<{ key: string[] }> }
): Promise<Response> {
  return GET(request, context);
}
