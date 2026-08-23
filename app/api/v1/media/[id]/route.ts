import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeAttachment } from "@/lib/mastodon/serializers";

function fromRow(att: Record<string, unknown>) {
  return {
    id: att.id as string,
    objectId: (att.object_id as string | null) ?? "",
    type: att.type as string,
    url: att.url as string,
    remoteUrl: (att.remote_url as string | null) ?? null,
    description: (att.description as string | null) ?? null,
    blurhash: (att.blurhash as string | null) ?? null,
    width: (att.width as number | null) ?? null,
    height: (att.height as number | null) ?? null,
    fileSize: (att.file_size as number | null) ?? null,
    mimeType: (att.mime_type as string | null) ?? null,
    sensitive: Boolean(att.sensitive),
    createdAt: att.created_at as string,
  };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const att = await env.DB
    .prepare("SELECT * FROM attachments WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
  if (att) return json(serializeAttachment(fromRow(att)));
  // Attachment uploaded but not yet attached to a status — check pending KV.
  const pendingRaw = await env.KV.get(`pending_media:${id}`);
  if (pendingRaw) {
    try {
      const pending = JSON.parse(pendingRaw) as Record<string, unknown>;
      return json(serializeAttachment({
        id: pending.id as string,
        objectId: "",
        type: pending.type as string,
        url: pending.url as string,
        remoteUrl: null,
        description: (pending.description as string | null) ?? null,
        blurhash: null,
        width: null,
        height: null,
        fileSize: (pending.fileSize as number | null) ?? null,
        mimeType: (pending.mimeType as string | null) ?? null,
        sensitive: pending.sensitive === true,
        createdAt: pending.createdAt as string,
      }));
    } catch { /* fall through to 404 */ }
  }
  return notFound();
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
  await env.KV.delete(`pending_media:${id}`);
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

  let description: string | null = null;
  let sensitive: boolean | undefined;
  const contentType = _request.headers.get("Content-Type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await _request.formData();
    description = (form.get("description") as string | null) ?? null;
    const s = form.get("sensitive");
    if (s !== null) sensitive = s === "true";
  } else {
    const body = await _request.json() as Record<string, unknown>;
    if (typeof body.description === "string") description = body.description;
    if (body.sensitive !== undefined) sensitive = body.sensitive === true || body.sensitive === "true";
  }

  const att = await env.DB
    .prepare("SELECT * FROM attachments WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
  if (att) {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (description !== null) { sets.push("description = ?"); vals.push(description); }
    if (sensitive !== undefined) { sets.push("sensitive = ?"); vals.push(sensitive ? 1 : 0); }
    if (sets.length > 0) {
      vals.push(id);
      await env.DB.prepare(`UPDATE attachments SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
    }
    const refreshed = await env.DB
      .prepare("SELECT * FROM attachments WHERE id = ?")
      .bind(id)
      .first<Record<string, unknown>>();
    return json(serializeAttachment(fromRow(refreshed!)));
  }

  // Not attached yet — update the pending KV entry.
  const pendingRaw = await env.KV.get(`pending_media:${id}`);
  if (!pendingRaw) return notFound();
  try {
    const pending = JSON.parse(pendingRaw) as Record<string, unknown>;
    if (description !== null) pending.description = description;
    if (sensitive !== undefined) pending.sensitive = sensitive;
    await env.KV.put(`pending_media:${id}`, JSON.stringify(pending), { expirationTtl: 3600 });
    return json(serializeAttachment({
      id: pending.id as string,
      objectId: "",
      type: pending.type as string,
      url: pending.url as string,
      remoteUrl: null,
      description: (pending.description as string | null) ?? null,
      blurhash: null,
      width: null,
      height: null,
      fileSize: (pending.fileSize as number | null) ?? null,
      mimeType: (pending.mimeType as string | null) ?? null,
      sensitive: pending.sensitive === true,
      createdAt: pending.createdAt as string,
    }));
  } catch {
    return notFound();
  }
}
