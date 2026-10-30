/**
 * Quote authorizations (FEP-044f, Mastodon 4.4+).
 *
 * Mastodon does not take a quoting server's word for it: a status that quotes a
 * post is rendered as **"pending approval"** until the quoting note carries a
 * `quoteAuthorization` issued by the quoted post's *server*. An
 * `interactionPolicy.canQuote.automaticApproval` entry alone is not enough —
 * `ActivityPub::VerifyQuoteService` only looks at the authorization (and
 * auto-accepts self-quotes). Both halves live here:
 *
 *  - **Outbound**: a local status quoting a remote post sends a `QuoteRequest`
 *    to the quoted author's inbox; its `Accept` carries the approval URI in
 *    `result`, which we store on the object and attach to the note (then
 *    redistribute it as an `Update`, which is how the pending quote becomes
 *    visible on the instances that already have the post). Quoting a **local**
 *    post needs no round trip: we are the quoted server, so the authorization is
 *    minted on the spot.
 *  - **Inbound**: a remote `QuoteRequest` for one of our posts is answered with
 *    an `Accept` (or a `Reject` when our interaction policy does not allow it)
 *    and the authorization is served at `/quote_authorizations/<id>`.
 */

import type { D1Database } from "@cloudflare/workers-types";
import {
  createQuoteAuthorization,
  getActorById,
  getObjectById,
  getQuoteAuthorizationByInteractingObject,
  isActorBlockedBy,
  isAcceptedFollower,
} from "@/lib/db";
import { generateId, objectIRI } from "@/lib/activitypub/utils";
import { QUOTE_AUTHORIZATION_CONTEXT } from "@/lib/activitypub/vocab";
import { collectFollowerInboxes } from "@/lib/activitypub/federation";
import { fetchAndCacheRemoteStatus } from "@/lib/activitypub/remote";
import { withRelayInboxes } from "@/lib/activitypub/relays";
import { enqueueDeliveries } from "@/lib/activitypub/queue";
import type { APActivity, APActor, APObject, LocalObject } from "@/lib/types";

export const QUOTE_AUTHORIZATION_TYPE = "QuoteAuthorization";
export const QUOTE_REQUEST_TYPE = "QuoteRequest";

export interface QuoteEnv {
  DB: D1Database;
  DELIVERY_QUEUE?: Queue | null;
  KV?: { get(key: string): Promise<string | null>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> } | null;
}

/**
 * Whether `actor` is allowed to quote `author`'s status given the author's
 * quote policy (Mastodon: public → anyone, followers → followers+author,
 * followed → accounts the author follows, nobody → only the author). Shared
 * by the immediate post route and the scheduled-publish cron: a quote is
 * validated when it is composed AND re-validated when it publishes (the
 * policy or a block may have changed in between, and the schedule-edit route
 * accepts a new `quoted_status_id` without its own validation).
 */
export async function quoteAllowed(
  db: D1Database,
  actor: { id: string },
  author: { id: string },
  policy: string
): Promise<boolean> {
  if (actor.id === author.id) return true;
  // Blocked users are never allowed to quote.
  if (await isActorBlockedBy(db, author.id, actor.id)) return false;
  switch (policy) {
    case "public":
      return true;
    case "followers":
      return isAcceptedFollower(db, actor.id, author.id);
    case "followed":
      return isAcceptedFollower(db, author.id, actor.id);
    default:
      return false; // nobody
  }
}

/**
 * Resolve a REMOTE author's federated quote policy (Mastodon 4.5 / FEP-044f
 * `interactionPolicy.canQuote`) and decide whether `actorId` may quote one of
 * their posts. Falls back to the conservative "followers" when no policy is
 * present or it cannot be parsed.
 */
export async function remoteQuoteAllowed(
  db: D1Database,
  actorId: string,
  author: { id: string; domain: string; username: string },
  raw: string | undefined
): Promise<boolean> {
  if (actorId === author.id) return true;
  if (await isActorBlockedBy(db, author.id, actorId)) return false;

  let canQuote: { automaticApproval?: unknown[] } | null = null;
  try {
    const ap = raw ? JSON.parse(raw) : null;
    canQuote = ap?.interactionPolicy?.canQuote ?? null;
  } catch { /* ignore malformed */ }

  if (!canQuote || !Array.isArray(canQuote.automaticApproval)) {
    return isAcceptedFollower(db, actorId, author.id); // conservative: followers
  }

  const auto = canQuote.automaticApproval.map((v) => String(v));
  if (auto.some((v) => /public/i.test(v))) return true;

  const followersIri = `https://${author.domain}/users/${author.username}/followers`;
  const followingIri = `https://${author.domain}/users/${author.username}/following`;
  if (auto.includes(followersIri) || auto.some((v) => /followers/i.test(v))) {
    return isAcceptedFollower(db, actorId, author.id);
  }
  if (auto.includes(followingIri) || auto.some((v) => /following/i.test(v))) {
    return isAcceptedFollower(db, author.id, actorId);
  }
  if (auto.includes(actorId)) return true;
  return false;
}

export function quoteAuthorizationIRI(baseUrl: string, id: string): string {
  return `${baseUrl}/quote_authorizations/${id}`;
}

/** Read a URI out of `result`/`approval_uri`-style values (string or object). */
export function approvalUriFrom(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const id = (value as Record<string, unknown>).id;
    if (typeof id === "string") return id;
  }
  return null;
}

/** Same host, ignoring the port and case. */
function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname.toLowerCase() === new URL(b).hostname.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Whether a fetched document is a `QuoteAuthorization` that authorizes exactly
 * this interaction: issued by the quoted post's server for the quoting status.
 */
export function matchesQuoteAuthorization(
  doc: Record<string, unknown> | null | undefined,
  expected: { interactingObject: string; interactionTarget: string; authorUri: string }
): boolean {
  if (!doc) return false;
  const type = doc.type;
  const isType = type === QUOTE_AUTHORIZATION_TYPE || (Array.isArray(type) && type.includes(QUOTE_AUTHORIZATION_TYPE));
  if (!isType) return false;
  const interacting = approvalUriFrom(doc.interactingObject);
  const target = approvalUriFrom(doc.interactionTarget);
  const author = approvalUriFrom(doc.attributedTo);
  if (!interacting || !target || !author) return false;
  return (
    interacting === expected.interactingObject &&
    target === expected.interactionTarget &&
    sameHost(author, expected.authorUri)
  );
}

/** The authorization document served at `/quote_authorizations/<id>`. */
export function buildQuoteAuthorization(
  baseUrl: string,
  row: { id: string; objectId: string; interactingObjectId: string },
  authorUri: string
): APObject {
  return {
    "@context": ["https://www.w3.org/ns/activitystreams", QUOTE_AUTHORIZATION_CONTEXT],
    id: quoteAuthorizationIRI(baseUrl, row.id),
    type: QUOTE_AUTHORIZATION_TYPE,
    attributedTo: authorUri,
    interactingObject: row.interactingObjectId,
    interactionTarget: row.objectId,
  } as unknown as APObject;
}

/**
 * Mint (idempotently) the authorization a **local** status quoting a **local**
 * post uses, and return its URI.
 */
export async function ensureLocalQuoteAuthorization(
  env: QuoteEnv,
  opts: { baseUrl: string; quoted: LocalObject; authorUsername: string; interactingObjectId: string }
): Promise<string | null> {
  const existing = await getQuoteAuthorizationByInteractingObject(env.DB, opts.interactingObjectId);
  if (existing) return quoteAuthorizationIRI(opts.baseUrl, existing.id);

  const id = generateId();
  await createQuoteAuthorization(env.DB, {
    id,
    objectId: opts.quoted.id,
    actorId: opts.quoted.actorId,
    interactingObjectId: opts.interactingObjectId,
  });
  return quoteAuthorizationIRI(opts.baseUrl, id);
}

/** The `QuoteRequest` a local status quoting a remote post sends. */
export function buildQuoteRequest(
  baseUrl: string,
  opts: { activityId: string; actorId: string; quotingObjectId: string; quotedObjectId: string }
): APActivity {
  return {
    "@context": ["https://www.w3.org/ns/activitystreams", QUOTE_AUTHORIZATION_CONTEXT],
    id: `${baseUrl}/activities/${opts.activityId}`,
    type: QUOTE_REQUEST_TYPE,
    actor: opts.actorId,
    // Mastodon resolves the quoting status from `instrument` (it may also inline
    // it); `object` is the post being quoted.
    object: opts.quotedObjectId,
    instrument: opts.quotingObjectId,
  } as unknown as APActivity;
}

/** The `Accept{QuoteRequest}` a quoted server answers with. */
export function buildAcceptQuoteRequest(
  baseUrl: string,
  opts: {
    id: string;
    actorId: string;
    quotedObjectId: string;
    quotingObjectId: string;
    requestId: string;
    approvalUri: string;
  }
): APActivity {
  return {
    "@context": ["https://www.w3.org/ns/activitystreams", QUOTE_AUTHORIZATION_CONTEXT],
    id: `${baseUrl}/activities/${opts.id}`,
    type: "Accept",
    actor: opts.actorId,
    object: {
      id: opts.requestId,
      type: QUOTE_REQUEST_TYPE,
      actor: opts.actorId,
      object: opts.quotedObjectId,
      instrument: opts.quotingObjectId,
    } as unknown as APObject,
    result: opts.approvalUri,
  } as unknown as APActivity;
}

/** The `Reject{QuoteRequest}` when our interaction policy does not allow the quote. */
export function buildRejectQuoteRequest(
  baseUrl: string,
  opts: { id: string; actorId: string; quotedObjectId: string; quotingObjectId: string; requestId: string }
): APActivity {
  return {
    "@context": ["https://www.w3.org/ns/activitystreams", QUOTE_AUTHORIZATION_CONTEXT],
    id: `${baseUrl}/activities/${opts.id}`,
    type: "Reject",
    actor: opts.actorId,
    object: {
      id: opts.requestId,
      type: QUOTE_REQUEST_TYPE,
      actor: opts.actorId,
      object: opts.quotedObjectId,
      instrument: opts.quotingObjectId,
    } as unknown as APObject,
  } as unknown as APActivity;
}

/**
 * Ask the quoted post's server for approval: the activity goes to the quoted
 * author's inbox through the delivery queue, signed by the quoting account.
 */
export async function sendQuoteRequest(
  env: QuoteEnv,
  opts: {
    baseUrl: string;
    actor: { id: string; username: string; privateKeyPem?: string | null };
    quotingObjectId: string;
    quoted: LocalObject;
  }
): Promise<boolean> {
  const author = await getActorById(env.DB, opts.quoted.actorId);
  const inbox = author?.endpoints?.sharedInbox ?? author?.inbox;
  if (!inbox) return false;

  const activity = buildQuoteRequest(opts.baseUrl, {
    activityId: generateId(),
    actorId: opts.actor.id,
    quotingObjectId: opts.quotingObjectId,
    quotedObjectId: opts.quoted.id,
  });
  await enqueueDeliveries(
    env.DELIVERY_QUEUE,
    [inbox],
    JSON.stringify(activity),
    opts.actor.id,
    `${opts.actor.id}#main-key`,
    opts.actor.privateKeyPem
  );
  return true;
}

/**
 * Redistribute a local status whose quote was just approved: the followers (and
 * the relays) that already stored the post only accept the quote when the note
 * carries the authorization.
 */
/** Failed fetches are parked so the pass does not retry the same dead quote forever. */
const QUOTE_FETCH_SKIP_PREFIX = "quote:missing:";
const QUOTE_FETCH_SKIP_TTL = 7 * 24 * 60 * 60;

/**
 * Fetch the quoted posts this instance is missing, a few per cron pass.
 *
 * A quote is rendered from the **local** copy of the quoted status, and nothing
 * guarantees this instance ever saw it (the account followed is the one that
 * quotes). New ingests fetch it (`ensureQuotedObjectCached`); this heals the
 * rows stored before that, and the ones whose fetch failed — the same repair
 * Mastodon's `RefetchAndVerifyQuoteWorker` does.
 */
export async function repairMissingQuotedObjects(env: QuoteEnv, limit = 5): Promise<number> {
  const rows = await env.DB
    .prepare(
      `SELECT o.quote_id AS quote_id FROM objects o
         LEFT JOIN objects q ON q.id = o.quote_id
        WHERE o.quote_id IS NOT NULL AND q.id IS NULL
        LIMIT ?`
    )
    .bind(limit)
    .all<{ quote_id: string }>()
    .catch(() => null);

  let fetched = 0;
  for (const row of rows?.results ?? []) {
    const quoteId = row.quote_id;
    if (!quoteId) continue;
    const skipKey = `${QUOTE_FETCH_SKIP_PREFIX}${quoteId}`;
    if (env.KV && (await env.KV.get(skipKey).catch(() => null))) continue;
    try {
      const result = await fetchAndCacheRemoteStatus(env.DB, quoteId);
      if (result.object) fetched += 1;
      else if (env.KV) await env.KV.put(skipKey, "1", { expirationTtl: QUOTE_FETCH_SKIP_TTL }).catch(() => {});
    } catch {
      if (env.KV) await env.KV.put(skipKey, "1", { expirationTtl: QUOTE_FETCH_SKIP_TTL }).catch(() => {});
    }
  }
  return fetched;
}

export async function redistributeQuoteAuthorization(
  env: QuoteEnv,
  opts: { baseUrl: string; object: LocalObject; authorizationUri: string }
): Promise<number> {
  const actor = await getActorById(env.DB, opts.object.actorId);
  if (!actor?.privateKeyPem) return 0;

  let note: Record<string, unknown> = {};
  try {
    note = JSON.parse(opts.object.raw) as Record<string, unknown>;
  } catch {
    return 0;
  }
  note.quoteAuthorization = opts.authorizationUri;
  // Mastodon only refreshes a quote on the *explicit* update path, which it
  // enters when the note carries `updated`; it does not mark the status as
  // edited unless the text, CW, media, poll or quote really changed, so this is
  // how the pending quote becomes approved without a false "edited" badge.
  note.updated = new Date().toISOString();
  const context = note["@context"];
  if (Array.isArray(context)) {
    if (!context.some((c) => typeof c === "object" && c && "quoteAuthorization" in (c as Record<string, unknown>))) {
      note["@context"] = [...context, QUOTE_AUTHORIZATION_CONTEXT];
    }
  } else {
    note["@context"] = [context ?? "https://www.w3.org/ns/activitystreams", QUOTE_AUTHORIZATION_CONTEXT];
  }

  const activity: APActivity = {
    "@context": (note["@context"] ?? ["https://www.w3.org/ns/activitystreams"]) as APActivity["@context"],
    id: `${opts.baseUrl}/activities/${generateId()}`,
    type: "Update",
    actor: actor.id,
    to: note.to as string[] | undefined,
    cc: note.cc as string[] | undefined,
    object: note as unknown as APObject,
  };

  const followers = await env.DB
    .prepare("SELECT actor_id FROM follows WHERE target_id = ? AND state = 'accepted'")
    .bind(actor.id)
    .all<{ actor_id: string }>();
  const fetchActor = async (id: string) => (await getActorById(env.DB, id)) as unknown as APActor | null;
  const inboxes = await collectFollowerInboxes(followers.results.map((r) => r.actor_id), fetchActor);
  const withRelays = await withRelayInboxes(env.DB, opts.object.visibility, inboxes);
  await enqueueDeliveries(
    env.DELIVERY_QUEUE,
    withRelays,
    JSON.stringify(activity),
    actor.id,
    `${actor.id}#main-key`,
    actor.privateKeyPem
  );
  return withRelays.length;
}

/**
 * Re-ask the quoted server for the quotes whose authorization never arrived:
 * a lost `Accept`, one that landed before this flow existed, or a server that
 * was down. Mastodon's `QuoteRequest` handler is idempotent (it re-answers and
 * keeps the same authorization), so re-sending is safe. Throttled per status in
 * KV so a server that never answers is not asked on every tick.
 */
export async function retryPendingQuoteRequests(
  env: QuoteEnv & { INSTANCE_URL?: string },
  limit = 10
): Promise<number> {
  const rows = await env.DB
    .prepare(
      `SELECT id, actor_id, quote_id FROM objects
        WHERE is_local = 1 AND quote_id IS NOT NULL AND quote_authorization_uri IS NULL
          AND visibility IN ('public', 'unlisted')
          AND datetime(published) >= datetime('now', '-7 days')
        ORDER BY published DESC LIMIT ?`
    )
    .bind(limit)
    .all<{ id: string; actor_id: string; quote_id: string }>();

  let sent = 0;
  for (const row of rows.results ?? []) {
    const marker = `quote:request:${row.id}`;
    try {
      if (env.KV) {
        if (await env.KV.get(marker)) continue;
        await env.KV.put(marker, "1", { expirationTtl: 6 * 3600 });
      }
    } catch { /* the marker is best-effort */ }

    try {
      const quoted = await getObjectById(env.DB, row.quote_id);
      if (!quoted || quoted.local) continue;
      const actor = await getActorById(env.DB, row.actor_id);
      if (!actor?.privateKeyPem || !actor.isLocal) continue;
      const baseUrl = env.INSTANCE_URL ? env.INSTANCE_URL.replace(/\/$/, "") : "";
      if (!baseUrl) continue;
      if (await sendQuoteRequest(env, { baseUrl, actor, quotingObjectId: row.id, quoted })) sent += 1;
    } catch { /* best-effort per status */ }
  }
  return sent;
}

/** The canonical object IRI of a local status, for building request pairs. */
export function quotedObjectIRI(baseUrl: string, objectId: string): string {
  return objectId.startsWith(baseUrl) ? objectId : objectIRI(baseUrl, objectId);
}
