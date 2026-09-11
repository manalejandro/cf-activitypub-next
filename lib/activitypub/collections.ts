/**
 * Federated Collections (FEP-7aa9, Mastodon 4.6+).
 *
 * Outbound: the actor advertises `featuredCollections`; the endpoint returns an
 * ActivityStreams `Collection` of `FeaturedCollection` objects whose
 * `orderedItems` are `FeaturedItem`s. Items of accounts hosted on this instance
 * carry a `FeatureAuthorization` served by us (remote Mastodon verifies the
 * authorization comes from the featured account's host).
 *
 * Inbound: when a remote actor advertises `featuredCollections`, we fetch the
 * collection and cache it in the local `collections`/`collection_items` tables
 * so remote profiles and search show it.
 */

import type { D1Database } from "@cloudflare/workers-types";
import type { APActor, LocalActor, LocalCollectionItem } from "@/lib/types";
import {
  getActorById,
  getCollectionById,
  getCollectionItems,
  replaceRemoteCollectionItems,
  upsertRemoteCollection,
  type CollectionRow,
} from "@/lib/db";
import { collectFollowerInboxes, safeFetch } from "./federation";
import { enqueueDeliveries } from "./queue";
import { DEFAULT_CONTEXT } from "./vocab";
import { generateId } from "./utils";

const AP_ACCEPT = 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';
const ITEMS_LIMIT = 150;
const SYNC_TTL_SECONDS = 3600;

function iso(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

export function collectionIRI(baseUrl: string, username: string, collectionId: string): string {
  return `${baseUrl}/users/${username}/collections/${collectionId}`;
}

export function featureAuthorizationIRI(baseUrl: string, username: string, itemId: string): string {
  return `${baseUrl}/users/${username}/feature_authorizations/${itemId}`;
}

/** `FeaturedCollection` AP object (FEP-7aa9) for a local collection. */
export function buildFeaturedCollection(
  baseUrl: string,
  username: string,
  col: CollectionRow,
  items: LocalCollectionItem[]
): Record<string, unknown> {
  const id = collectionIRI(baseUrl, username, col.id);
  const actorId = `${baseUrl}/users/${username}`;
  const tag = col.tag_name ? col.tag_name.replace(/^#/, "") : null;

  return {
    "@context": DEFAULT_CONTEXT,
    id,
    type: "FeaturedCollection",
    name: col.name,
    ...(col.language && col.description
      ? { summaryMap: { [col.language]: col.description } }
      : { summary: col.description ?? "" }),
    attributedTo: actorId,
    url: `${baseUrl}/collections/${col.id}`,
    totalItems: items.length,
    sensitive: Boolean(col.sensitive),
    discoverable: Boolean(col.discoverable),
    published: iso(col.created_at),
    updated: iso(col.updated_at),
    ...(tag
      ? { topic: { type: "Hashtag", name: `#${tag}`, href: `${baseUrl}/tags/${encodeURIComponent(tag)}` } }
      : {}),
    orderedItems: items.map((item) => ({
      id: `${id}/items/${item.id}`,
      type: "FeaturedItem",
      featuredObject: item.accountId,
      // Only accounts we host can issue an authorization. Items featuring
      // remote accounts are still listed; remote Mastodon will verify their
      // authorization separately (best-effort without the request flow).
      ...(item.accountId.startsWith(`${baseUrl}/`)
        ? { featureAuthorization: featureAuthorizationIRI(baseUrl, username, item.id) }
        : {}),
      published: iso(item.createdAt),
    })),
  };
}

/**
 * Federate a collection change to the actor's followers. Mastodon handles
 * `Update{FeaturedCollection}` by re-processing the collection (and
 * `Delete{object: <collection IRI>}` by removing it).
 */
export async function deliverCollectionUpdate(
  env: { DB: D1Database; DELIVERY_QUEUE?: unknown },
  actor: LocalActor,
  collection: CollectionRow,
  verb: "Update" | "Delete" = "Update"
): Promise<void> {
  if (!actor.privateKeyPem) return;
  const baseUrl = `https://${actor.domain}`;
  const username = actor.username;
  const objectId = collectionIRI(baseUrl, username, collection.id);

  const object = verb === "Update"
    ? buildFeaturedCollection(baseUrl, username, collection, await getCollectionItems(env.DB, collection.id))
    : objectId;

  const activity = {
    "@context": DEFAULT_CONTEXT,
    id: `${baseUrl}/activities/${generateId()}`,
    type: verb,
    actor: actor.id,
    object,
    to: [`${baseUrl}/users/${username}/followers`],
  };

  const followers = await env.DB
    .prepare("SELECT actor_id FROM follows WHERE target_id = ? AND state = 'accepted'")
    .bind(actor.id)
    .all<{ actor_id: string }>();

  const fetchActor = async (id: string): Promise<APActor | null> => {
    const cached = await getActorById(env.DB, id);
    return (cached as unknown as APActor) ?? null;
  };
  const inboxes = await collectFollowerInboxes((followers.results ?? []).map((r) => r.actor_id), fetchActor);
  if (inboxes.length === 0) return;

  await enqueueDeliveries(
    env.DELIVERY_QUEUE as never,
    inboxes,
    JSON.stringify(activity),
    actor.id,
    `${actor.id}#main-key`,
    actor.privateKeyPem
  );
}

interface RemoteCollectionDoc {
  id?: unknown;
  type?: unknown;
  name?: unknown;
  url?: unknown;
  summary?: unknown;
  summaryMap?: unknown;
  sensitive?: unknown;
  discoverable?: unknown;
  published?: unknown;
  updated?: unknown;
  topic?: { name?: unknown } | null;
  orderedItems?: unknown[];
}

interface CollectionListingDoc {
  type?: unknown;
  first?: unknown;
  next?: unknown;
  orderedItems?: unknown[];
}

function stringId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
    return (value as { id: string }).id;
  }
  return null;
}

function featuredAccountUri(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  return stringId((item as { featuredObject?: unknown }).featuredObject);
}

/**
 * Fetch and cache a remote actor's `featuredCollections`. Throttled per actor
 * (KV, 1h) so profile views don't refetch on every request.
 */
export async function syncRemoteCollections(
  db: D1Database,
  kv: { get(key: string): Promise<string | null>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> } | null | undefined,
  actorId: string,
  opts: { force?: boolean } = {}
): Promise<void> {
  const actor = await getActorById(db, actorId);
  if (!actor || actor.isLocal || !actor.collectionsUrl) return;

  const marker = `collections:sync:${actorId}`;
  if (!opts.force && kv) {
    const recent = await kv.get(marker).catch(() => null);
    if (recent) return;
  }

  const listing = await fetchListing(actor.collectionsUrl);
  if (!listing) return;

  const objects = Array.isArray(listing.orderedItems)
    ? listing.orderedItems
    : await fetchFirstPages(listing);

  for (const raw of objects.slice(0, ITEMS_LIMIT)) {
    if (!raw || typeof raw !== "object") continue;
    const doc = raw as RemoteCollectionDoc;
    const id = stringId(doc.id);
    if (!id || doc.type !== "FeaturedCollection") continue;
    // Mastodon only accepts collections hosted on the account's own domain.
    try {
      if (new URL(id).hostname !== actor.domain) continue;
    } catch {
      continue;
    }

    const summaryMap = doc.summaryMap && typeof doc.summaryMap === "object"
      ? doc.summaryMap as Record<string, unknown>
      : null;
    const description = typeof doc.summary === "string"
      ? doc.summary
      : summaryMap ? (Object.values(summaryMap)[0] as string | undefined) ?? null : null;
    const language = summaryMap ? Object.keys(summaryMap)[0] ?? null : null;
    const published = iso(typeof doc.published === "string" ? doc.published : null) ?? new Date().toISOString();
    const updated = iso(typeof doc.updated === "string" ? doc.updated : null) ?? published;

    await upsertRemoteCollection(db, {
      id,
      accountId: actor.id,
      name: typeof doc.name === "string" && doc.name ? doc.name : "Collection",
      description,
      url: typeof doc.url === "string" ? doc.url : null,
      language,
      tagName: typeof doc.topic?.name === "string" ? doc.topic.name.replace(/^#/, "") : null,
      sensitive: doc.sensitive === true,
      discoverable: doc.discoverable !== false,
      createdAt: published,
      updatedAt: updated,
    });

    const items = Array.isArray(doc.orderedItems) ? doc.orderedItems : [];
    const accountIds = items.map(featuredAccountUri).filter((v): v is string => v !== null);
    await replaceRemoteCollectionItems(db, id, accountIds);
  }

  if (kv) await kv.put(marker, "1", { expirationTtl: SYNC_TTL_SECONDS }).catch(() => {});
}

async function fetchListing(url: string): Promise<CollectionListingDoc | null> {
  try {
    const res = await safeFetch(url, { headers: { Accept: AP_ACCEPT } }, 8000);
    if (!res?.ok) return null;
    const doc = await res.json() as CollectionListingDoc;
    return doc && typeof doc === "object" ? doc : null;
  } catch {
    return null;
  }
}

/** Follow `first`/`next` for the first pages of a paginated collection. */
async function fetchFirstPages(listing: CollectionListingDoc): Promise<unknown[]> {
  const objects: unknown[] = [];
  let next = stringId(listing.first);
  for (let page = 0; next && page < 5; page++) {
    const doc = await fetchListing(next);
    if (!doc) break;
    if (Array.isArray(doc.orderedItems)) objects.push(...doc.orderedItems);
    next = stringId(doc.next);
  }
  return objects;
}

/** Look up a collection item and the actor it belongs to (for authorizations). */
export async function getCollectionItemContext(
  db: D1Database,
  itemId: string
): Promise<{ item: LocalCollectionItem; collection: CollectionRow } | null> {
  const item = await db
    .prepare("SELECT id, collection_id, account_id, state, created_at FROM collection_items WHERE id = ?")
    .bind(itemId)
    .first<{ id: string; collection_id: string; account_id: string; state: string; created_at: string }>();
  if (!item) return null;
  const collection = await getCollectionById(db, item.collection_id);
  if (!collection) return null;
  return {
    item: {
      id: item.id,
      collectionId: item.collection_id,
      accountId: item.account_id,
      state: item.state === "pending" ? "pending" : "accepted",
      createdAt: item.created_at,
    },
    collection,
  };
}
