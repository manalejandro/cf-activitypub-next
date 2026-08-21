import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, badRequest } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { createCollection, addAccountToCollection, getCollectionById } from "@/lib/db";
import { serializeCollection } from "@/lib/mastodon/serializers";
import { generateId } from "@/lib/activitypub/utils";

// POST /api/v1/collections — create a new Collection.
export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const domain = new URL(request.url).hostname;

  let body: Record<string, unknown> = {};
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    body = await request.json() as Record<string, unknown>;
  } else {
    const form = await request.formData();
    body = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return badRequest("name is required");
  if (name.length > 40) return json({ error: "Validation failed: Name is too long (maximum is 40 characters)" }, 422);

  const description = typeof body.description === "string" ? body.description : null;
  if (description && description.length > 100) return json({ error: "Validation failed: Description is too long (maximum is 100 characters)" }, 422);

  const language = typeof body.language === "string" ? body.language : null;
  const tagName = typeof body.tag_name === "string" ? body.tag_name : null;
  const sensitive = body.sensitive === true || body.sensitive === "true";
  const discoverable = body.discoverable === undefined ? true : (body.discoverable === true || body.discoverable === "true");

  const id = generateId();
  const now = new Date().toISOString();
  await createCollection(env.DB, {
    id,
    accountId: actor.id,
    name,
    description,
    language,
    tagName,
    sensitive,
    discoverable,
    local: true,
    createdAt: now,
    updatedAt: now,
  });

  const rawAccountIds = body.account_ids;
  if (Array.isArray(rawAccountIds)) {
    for (const aid of rawAccountIds) {
      await addAccountToCollection(env.DB, id, String(aid));
    }
  }

  const col = await getCollectionById(env.DB, id);
  if (!col) return badRequest("Failed to create collection");
  return json({ collection: serializeCollection(col, domain) });
}
