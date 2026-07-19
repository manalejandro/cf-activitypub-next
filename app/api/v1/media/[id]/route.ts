import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeAttachment } from "@/lib/mastodon/serializers";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const att = await env.DB
    .prepare("SELECT * FROM attachments WHERE id = ?")
    .first<Record<string, unknown>>(id);
  if (!att) return notFound();
  return json(serializeAttachment({
    id: att.id as string,
    objectId: att.object_id as string,
    type: att.type as string,
    url: att.url as string,
    remoteUrl: (att.remote_url as string | null) ?? null,
    description: (att.description as string | null) ?? null,
    blurhash: (att.blurhash as string | null) ?? null,
    width: (att.width as number | null) ?? null,
    height: (att.height as number | null) ?? null,
    fileSize: (att.file_size as number | null) ?? null,
    mimeType: (att.mime_type as string | null) ?? null,
    createdAt: att.created_at as string,
  }));
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const me = await getAuthenticatedActor(_request, env.DB);
  if (!me) return unauthorized();
  await env.DB.prepare("DELETE FROM attachments WHERE id = ?").bind(id).run();
  return json({});
}

export async function PUT(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const me = await getAuthenticatedActor(_request, env.DB);
  if (!me) return unauthorized();
  const body = await _request.json() as Record<string, unknown>;
  if (typeof body.description === "string") {
    await env.DB
      .prepare("UPDATE attachments SET description = ? WHERE id = ?")
      .bind(body.description, id)
      .run();
  }
  const att = await env.DB
    .prepare("SELECT * FROM attachments WHERE id = ?")
    .first<Record<string, unknown>>(id);
  if (!att) return notFound();
  return json(serializeAttachment({
    id: att.id as string,
    objectId: att.object_id as string,
    type: att.type as string,
    url: att.url as string,
    remoteUrl: (att.remote_url as string | null) ?? null,
    description: (att.description as string | null) ?? null,
    blurhash: (att.blurhash as string | null) ?? null,
    width: (att.width as number | null) ?? null,
    height: (att.height as number | null) ?? null,
    fileSize: (att.file_size as number | null) ?? null,
    mimeType: (att.mime_type as string | null) ?? null,
    createdAt: att.created_at as string,
  }));
}
