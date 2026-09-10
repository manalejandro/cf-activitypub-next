import { type NextRequest } from "next/server";
import { getCloudflareContext, activityJson, notFound } from "@/lib/cf";
import { getActorByUsername, getActorStatuses, getAttachmentsByObjectIds, getActorById, countActorPublicStatuses } from "@/lib/db";
import { buildNote, buildCreate, buildOrderedCollection, buildOrderedCollectionPage, actorIRI } from "@/lib/activitypub/utils";
import { fetchRemoteObject } from "@/lib/activitypub/federation";
import { enqueueDeliveries } from "@/lib/activitypub/queue";
import { mlsObjectTypeFromType } from "@/lib/activitypub/vocab";
import { storePublicMlsEnvelope } from "@/lib/activitypub/mlsEnvelope";
import { getAuthenticatedActor } from "@/lib/auth";
import {
  upsertMlsKeyPackage,
  setMlsKeyPackageActive,
  deleteMlsKeyPackageByObjectId,
  deleteMlsMessagesByObjectId,
  insertMlsMessage,
} from "@/lib/db";
import type { APAttachment, APTag, LocalAttachment, APActor, APActivity } from "@/lib/types";

interface MlsOutboxObject {
  id?: string;
  type?: string | string[];
  content?: string | null;
  // Envelope re-sealed to the sender's own key package so the sender can read
  // their own copy locally. Falls back to `content` when absent.
  senderContent?: string | null;
  mediaType?: string | null;
  encoding?: string | null;
  ciphersuite?: string;
  conversation?: string | null;
  to?: unknown;
  cc?: unknown;
  published?: string;
}

function toAPAttachment(att: LocalAttachment): APAttachment {
  const mimeType = att.mimeType ?? "application/octet-stream";
  let type: APAttachment["type"] = "Document";
  if (mimeType.startsWith("image/")) type = "Image";
  else if (mimeType.startsWith("video/")) type = "Video";
  else if (mimeType.startsWith("audio/")) type = "Audio";
  return {
    id: att.url,
    type,
    mediaType: mimeType,
    url: att.url,
    ...(att.description ? { name: att.description } : {}),
    ...(att.blurhash ? { blurhash: att.blurhash } : {}),
    ...(att.width != null ? { width: att.width } : {}),
    ...(att.height != null ? { height: att.height } : {}),
  };
}

// GET /users/:username/outbox
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { username } = await params;
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  // Remote instances fetch the outbox when resolving an account; a burst of
  // resolutions must not hammer D1. Cache the collection header and each page
  // in KV with a short TTL (new posts appear within ~2 minutes).
  const pageParam = request.nextUrl.searchParams.get("page");
  const cacheKey = `ap:outbox:${username.toLowerCase()}${pageParam ? `:${pageParam.slice(0, 80)}` : ""}`;
  const cached = await env.KV.get(cacheKey).catch(() => null);
  if (cached) {
    return activityJson(JSON.parse(cached) as Record<string, unknown>);
  }

  const actor = await getActorByUsername(env.DB, username, domain);
  if (!actor || !actor.isLocal || actor.suspended) return notFound("Actor not found");

  const outboxId = `${actorIRI(baseUrl, username)}/outbox`;
  const page = pageParam;

  let response: Record<string, unknown>;
  if (!page) {
    // totalItems must count only what the collection actually exposes (public),
    // not statusesCount (which includes followers-only/direct posts).
    response = buildOrderedCollection(outboxId, await countActorPublicStatuses(env.DB, actor.id));
  } else {
    const maxId = page !== "true" ? page : undefined;
    const statuses = await getActorStatuses(env.DB, actor.id, 20, maxId);
    const attachmentMap = await getAttachmentsByObjectIds(env.DB, statuses.map((s) => s.id));

    const items = statuses
      .filter((s) => s.visibility === "public")
      .map((s) => {
        // s.id is the full object IRI (https://{domain}/objects/{uuid}); buildNote
        // expects the bare uuid and wraps it with objectIRI, so passing the full
        // IRI would produce a double-prefixed id (https://{domain}/objects/https://…)
        // and cause the remote instance to ingest the same post twice.
        const objectUuid = s.id.split("/").pop() ?? s.id;
        const attachments = (attachmentMap.get(s.id) ?? []).map(toAPAttachment);
        let tags: APTag[] | undefined;
        let to: string[] | undefined;
        let cc: string[] | undefined;
        try {
          const raw = JSON.parse(s.raw);
          if (Array.isArray(raw.tag)) tags = raw.tag as APTag[];
          if (Array.isArray(raw.to)) to = raw.to as string[];
          if (Array.isArray(raw.cc)) cc = raw.cc as string[];
        } catch { /* ignore parse errors */ }
        const note = buildNote(baseUrl, objectUuid, {
          actorUsername: username,
          content: s.content ?? "",
          published: s.published,
          visibility: s.visibility as "public" | "unlisted" | "private" | "direct",
          inReplyTo: s.inReplyToId ?? undefined,
          sensitive: s.sensitive,
          summary: s.contentWarning ?? undefined,
          language: s.language ?? undefined,
          tags,
          to,
          cc,
        });
        if (attachments.length > 0) {
          note.attachment = attachments;
        }
        return buildCreate(baseUrl, actorIRI(baseUrl, username), note, objectUuid + "-create");
      });

    // Advance the cursor on the last fetched status regardless of visibility so
    // a page containing unlisted posts can't strand older public statuses.
    const lastStatus = statuses[statuses.length - 1];
    const nextId =
      statuses.length === 20 && lastStatus
        ? `${outboxId}?page=${encodeURIComponent(lastStatus.id)}`
        : undefined;

    response = buildOrderedCollectionPage(
      outboxId,
      `${outboxId}?page=${encodeURIComponent(page)}`,
      items,
      nextId
    );
  }

  await env.KV.put(cacheKey, JSON.stringify(response), { expirationTtl: 120 }).catch(() => {});
  return activityJson(response);
}

// ─────────────────────────────────────────
// POST /users/:username/outbox — local MLS publishing
//
// Accepts ActivityPub activities wrapping MLS objects (RFC 9420 draft) from
// the authenticated local actor's own client. The server only manages
// envelopes/key packages — it never sees or decrypts message plaintext.
// ─────────────────────────────────────────

function collectAudience(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === "string") out.push(item);
      else if (item && typeof item === "object") {
        const href = (item as { href?: unknown }).href;
        if (typeof href === "string") out.push(href);
      }
    }
    return out;
  }
  if (typeof value === "object") {
    const href = (value as { href?: unknown }).href;
    if (typeof href === "string") return [href];
  }
  return [];
}

async function resolveRemoteInbox(
  db: D1Database,
  actorId: string
): Promise<string | null> {
  const cached = await getActorById(db, actorId);
  if (cached?.inbox) return cached.inbox;
  try {
    const fetched = await fetchRemoteObject(actorId) as APActor | null;
    if (fetched?.inbox) return fetched.inbox;
  } catch {
    /* ignore */
  }
  return null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { username } = await params;
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  const actor = await getActorByUsername(env.DB, username, domain);
  if (!actor || !actor.isLocal || !actor.privateKeyPem) return notFound("Actor not found");

  const authed = await getAuthenticatedActor(request, env.DB);
  if (!authed || authed.id !== actor.id) {
    return new Response(
      JSON.stringify({ error: "Not authorized to post to this outbox" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  let activity: {
    id?: string;
    type?: string;
    actor?: unknown;
    to?: unknown;
    cc?: unknown;
    published?: string;
    object?: unknown;
  };
  try {
    activity = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  if (typeof activity.type !== "string" || !activity.type) {
    return new Response(
      JSON.stringify({ error: "activity.type must be a string" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  const type = activity.type.toLowerCase();
  const actorIri = actorIRI(baseUrl, username);
  const activityActor =
    typeof activity.actor === "string" ? activity.actor : (activity.actor as { id?: string })?.id;
  if (activityActor !== actorIri) {
    return new Response(
      JSON.stringify({ error: "activity.actor must be the authenticated actor" }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  // Only MLS-related activity types are accepted on the AP outbox endpoint.
  if (!["create", "add", "remove", "delete"].includes(type)) {
    return new Response(
      JSON.stringify({ error: "Only MLS Create/Add/Remove/Delete activities are supported" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const object = (activity.object ?? null) as MlsOutboxObject | string | null;
  let objectId = typeof object === "string"
    ? object
    : (typeof object?.id === "string" ? object.id : null);
  // Reject foreign IRIs on MLS mutations: object ids must be local (canonical
  // /objects/ form) or actor-scoped before being canonicalised.
  if (objectId && !objectId.startsWith(`${baseUrl}/objects/`) && !objectId.startsWith(`${actorIri}/`)) {
    return new Response(
      JSON.stringify({ error: "object.id must belong to this actor/instance" }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }
  // Local MLS objects must live under https://{domain}/objects/{uuid} so the
  // Mastodon API status-id encoding (encode/decodeStatusId) round-trips and
  // status detail pages can resolve them. Actors may send actor-scoped IDs
  // (`…/users/name/objects/…`); normalise them to the canonical form.
  if (objectId && objectId.startsWith(`${actorIri}/objects/`)) {
    const seg = objectId.split("/").pop();
    if (seg) {
      objectId = `${baseUrl}/objects/${seg}`;
      if (object && typeof object === "object") object.id = objectId;
    }
  }
  const objectType = object && typeof object === "object"
    ? (mlsObjectTypeFromType((object as { type?: unknown }).type) ?? "")
    : "";

  if (type === "create" && (!object || typeof object !== "object" || !object.id || !objectType)) {
    return new Response(
      JSON.stringify({ error: "Create must wrap an MLS object (KeyPackage/Welcome/GroupInfo/PrivateMessage/PublicMessage)" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  if (type === "add" || type === "remove" || type === "delete") {
    if (!objectId) {
      return new Response(
        JSON.stringify({ error: "Missing activity.object" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  let published = new Date().toISOString();
  if (typeof activity.published === "string") {
    const parsed = new Date(activity.published);
    if (isNaN(parsed.getTime())) {
      return new Response(
        JSON.stringify({ error: "activity.published is not a valid date" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    published = parsed.toISOString();
  }

  try {
    if (type === "create" && objectType === "KeyPackage") {
      // Publish a key package: it becomes part of this actor's keyPackages
      // collection and is cached locally (no fan-out needed — peers fetch the
      // collection on demand when encrypting to this actor).
      const obj = object as MlsOutboxObject;
      await upsertMlsKeyPackage(env.DB, {
        id: obj.id!,
        actorId: actor.id,
        objectId: obj.id!,
        ciphersuite: obj.ciphersuite ?? null,
        mediaType: obj.mediaType ?? null,
        encoding: obj.encoding ?? null,
        content: obj.content ?? null,
        isActive: true,
      });
    } else if (type === "create") {
      // PrivateMessage / PublicMessage / Welcome / GroupInfo — route to the
      // explicit local recipients and deliver to remote recipients' inboxes.
      const obj = object as MlsOutboxObject;
      const recipients = [...collectAudience(activity.to), ...collectAudience(activity.cc)]
        .filter((iri) => iri !== "https://www.w3.org/ns/activitystreams#Public" && iri !== "as:Public");
      const remoteInboxes: string[] = [];
      const activityId = activity.id ?? `${actorIri}/mls/${Date.now()}`;
      for (const iri of new Set(recipients)) {
        if (!iri.startsWith(baseUrl + "/")) {
          const inbox = await resolveRemoteInbox(env.DB, iri);
          if (inbox) remoteInboxes.push(inbox);
          continue;
        }
        const localRecipient = await getActorById(env.DB, iri);
        if (localRecipient?.isLocal) {
          await insertMlsMessage(env.DB, {
            id: activityId,
            type: activity.type!,
            actorId: actor.id,
            recipientId: localRecipient.id,
            objectId: objectId ?? null,
            objectType: objectType || null,
            conversation: obj.conversation ?? null,
            mediaType: obj.mediaType ?? null,
            encoding: obj.encoding ?? null,
            content: obj.content ?? null,
            raw: JSON.stringify(activity),
            published,
          });
        }
      }
      // Keep a copy in the sender's own messages so the composer can see it
      // after sending (mirrors how the outbox page lists recent activity).
      // Prefer the self-sealed copy when the client sent one, otherwise the
      // plaintext would be sealed to the recipient's key and the sender could
      // never decrypt their own sent message.
      await insertMlsMessage(env.DB, {
        id: activityId,
        type: activity.type!,
        actorId: actor.id,
        recipientId: actor.id,
        objectId: objectId ?? null,
        objectType: objectType || null,
        conversation: obj.conversation ?? null,
        mediaType: obj.mediaType ?? null,
        encoding: obj.encoding ?? null,
        content: obj.senderContent ?? obj.content ?? null,
        raw: JSON.stringify(activity),
        published,
      });
      // Public MLS messages are also surfaced on the public timeline as
      // "encrypted envelope" posts for the sender (the ciphertext is never decrypted).
      await storePublicMlsEnvelope(
        env.DB,
        activity as APActivity,
        { id: objectId ?? activityId, content: obj.content, mediaType: obj.mediaType, encoding: obj.encoding, ciphersuite: obj.ciphersuite, conversation: obj.conversation },
        objectType || "",
        actor.id,
        published,
        true
      );
      if (remoteInboxes.length > 0) {
        await enqueueDeliveries(env.DELIVERY_QUEUE, remoteInboxes, JSON.stringify(activity), actor.id, `${actor.id}#main-key`, actor.privateKeyPem);
      }
    } else if (type === "add") {
      await setMlsKeyPackageActive(env.DB, objectId!, true, actor.id);
    } else if (type === "remove") {
      await setMlsKeyPackageActive(env.DB, objectId!, false, actor.id);
    } else if (type === "delete") {
      await deleteMlsKeyPackageByObjectId(env.DB, objectId!, actor.id);
      await deleteMlsMessagesByObjectId(env.DB, objectId!, actor.id);
      const remoteInboxes: string[] = [];
      for (const iri of [...collectAudience(activity.to), ...collectAudience(activity.cc)]) {
        if (!iri.startsWith(baseUrl + "/") && iri !== "https://www.w3.org/ns/activitystreams#Public") {
          const inbox = await resolveRemoteInbox(env.DB, iri);
          if (inbox) remoteInboxes.push(inbox);
        }
      }
      if (remoteInboxes.length > 0) {
        await enqueueDeliveries(env.DELIVERY_QUEUE, remoteInboxes, JSON.stringify(activity), actor.id, `${actor.id}#main-key`, actor.privateKeyPem);
      }
    }
  } catch (err) {
    console.error("[outbox] MLS processing error:", err);
    return new Response(
      JSON.stringify({ error: "Failed to process MLS activity" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({ type: activity.type, object: objectId }),
    { status: 201, headers: { "Content-Type": "application/json" } }
  );
}
