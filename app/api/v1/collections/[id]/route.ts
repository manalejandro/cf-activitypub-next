import { type NextRequest } from "next/server";
import type { D1Database } from "@cloudflare/workers-types";
import { getCloudflareContext, json, unauthorized, notFound, badRequest } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import {
  getCollectionById,
  getCollectionItems,
  updateCollection,
  deleteCollection,
  getActorById,
} from "@/lib/db";
import { serializeCollection, serializeAccount } from "@/lib/mastodon/serializers";

async function serializeWithAccounts(
  db: D1Database,
  collectionId: string,
  domain: string
) {
  const col = await getCollectionById(db, collectionId);
  if (!col) return null;
  const items = await getCollectionItems(db, collectionId);
  const accountIds = [col.account_id, ...items.map((i) => i.accountId)];
  const accounts = [];
  const seen = new Set<string>();
  for (const aid of accountIds) {
    if (seen.has(aid)) continue;
    seen.add(aid);
    const actor = await getActorById(db, aid);
    if (actor) accounts.push(serializeAccount(actor, domain));
  }
  return { col, items, accounts };
}

// GET /api/v1/collections/:id — get a single Collection with its accounts.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const domain = new URL(request.url).hostname;

  const data = await serializeWithAccounts(env.DB, id, domain);
  if (!data) return notFound("Collection not found");

  return json({
    accounts: data.accounts,
    collection: serializeCollection(data.col, domain, data.items),
  });
}

// PATCH /api/v1/collections/:id — update a Collection's metadata.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const col = await getCollectionById(env.DB, id);
  if (!col) return notFound("Collection not found");
  if (col.account_id !== actor.id) return json({ error: "This action is not allowed" }, 403);

  const body = await request.json() as Record<string, unknown>;

  const fields: Parameters<typeof updateCollection>[2] = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return badRequest("name is required");
    if (name.length > 40) return json({ error: "Validation failed: Name is too long (maximum is 40 characters)" }, 422);
    fields.name = name;
  }
  if (body.description !== undefined) {
    const description = body.description === null ? null : String(body.description);
    if (description && description.length > 100) return json({ error: "Validation failed: Description is too long (maximum is 100 characters)" }, 422);
    fields.description = description;
  }
  if (body.language !== undefined) fields.language = body.language === null ? null : String(body.language);
  if (body.tag_name !== undefined) fields.tagName = body.tag_name === null ? null : String(body.tag_name);
  if (body.sensitive !== undefined) fields.sensitive = Boolean(body.sensitive);
  if (body.discoverable !== undefined) fields.discoverable = Boolean(body.discoverable);

  await updateCollection(env.DB, id, fields);

  const updated = await getCollectionById(env.DB, id);
  const items = await getCollectionItems(env.DB, id);
  if (!updated) return notFound("Collection not found");
  return json({ collection: serializeCollection(updated, domain, items) });
}

// DELETE /api/v1/collections/:id — delete a Collection.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const col = await getCollectionById(env.DB, id);
  if (!col) return notFound("Collection not found");
  if (col.account_id !== actor.id) return json({ error: "This action is not allowed" }, 403);

  await deleteCollection(env.DB, id);
  return json({});
}
