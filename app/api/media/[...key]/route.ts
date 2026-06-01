import { type NextRequest } from "next/server";
import { getCloudflareContext } from "@/lib/cf";

// GET /api/media/[...key] — Serve a file from R2
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ key: string[] }> }
): Promise<Response> {
  const { key } = await params;
  const r2Key = key.join("/");

  const { env } = getCloudflareContext();
  const object = await env.R2.get(r2Key);

  if (!object) {
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("ETag", object.httpEtag);

  return new Response(object.body, { headers });
}
