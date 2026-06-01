import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";

// PUT /api/v1/media/:id — Update description of a pending media attachment
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const pendingRaw = await env.KV.get(`pending_media:${id}`);
  if (!pendingRaw) return json({ error: "Media not found" }, 404);

  const body = await request.json() as { description?: string };
  const description = (body.description as string | null | undefined) ?? null;

  const pending = JSON.parse(pendingRaw) as Record<string, unknown>;
  pending.description = description;
  await env.KV.put(`pending_media:${id}`, JSON.stringify(pending), { expirationTtl: 3600 });

  return json({
    id,
    type: pending.type,
    url: pending.url,
    preview_url: pending.url,
    remote_url: null,
    description,
    blurhash: null,
    meta: {},
  });
}
