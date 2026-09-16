import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeAttachment } from "@/lib/mastodon/serializers";

/** R2 key embedded in a media URL (`/api/media/<key>`), if any. */
function r2KeyFromUrl(url: string): string | null {
  const marker = "/api/media/";
  const idx = url.indexOf(marker);
  return idx === -1 ? null : url.slice(idx + marker.length);
}

/**
 * Attachment ownership, with no `actor_id` column needed:
 *  - attached rows belong to their object's author;
 *  - pending uploads belong to the actor stamped in the KV blob;
 *  - legacy unattached rows fall back to the `media/<username>/` key prefix.
 */
async function ownsAttachment(
  env: ReturnType<typeof getCloudflareContext>["env"],
  me: { id: string; username: string },
  id: string,
  att: Record<string, unknown> | null
): Promise<{ allowed: boolean; pending: Record<string, unknown> | null }> {
  let pending: Record<string, unknown> | null = null;
  try {
    const raw = await env.KV.get(`pending_media:${id}`);
    if (raw) pending = JSON.parse(raw) as Record<string, unknown>;
  } catch { /* malformed pending blob */ }

  if (att?.object_id) {
    const obj = await env.DB
      .prepare("SELECT actor_id FROM objects WHERE id = ?")
      .bind(att.object_id)
      .first<{ actor_id: string }>();
    return { allowed: obj?.actor_id === me.id, pending };
  }
  if (pending) return { allowed: pending.actorId === me.id, pending };
  const key = att ? r2KeyFromUrl(String(att.url ?? "")) : null;
  return { allowed: Boolean(key && key.startsWith(`media/${me.username}/`)), pending };
}

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
  const att = await env.DB
    .prepare("SELECT * FROM attachments WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
  const { allowed, pending } = await ownsAttachment(env, me, id, att);
  if (!allowed) return notFound();
  // Remove the binary too — otherwise deleted/sensitive media stays fetchable.
  const r2Key = (pending?.r2Key as string | undefined) ?? (att ? r2KeyFromUrl(String(att.url ?? "")) : null);
  if (r2Key) await env.R2.delete(r2Key).catch(() => {});
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

  const existingRow = await env.DB
    .prepare("SELECT * FROM attachments WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
  const ownership = await ownsAttachment(env, me, id, existingRow);
  if (!ownership.allowed) return notFound();

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
