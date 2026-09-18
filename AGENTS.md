<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# CF ActivityPub — Agent Instructions

A Mastodon-compatible ActivityPub server running entirely on Cloudflare Workers via **Next.js 16 App Router + @opennextjs/cloudflare**. There is no Node.js server, no Docker, no database server — everything is a Cloudflare binding. This file is the working contract for anyone (human or AI) changing this repo.

## Ground rules

- **Next.js 16** (see the warning block above). Route handlers receive `{ params }` as a `Promise` and must `await` it. Do not assume your training data's API; read `node_modules/next/dist/docs/` first.
- **`src/worker.ts` is excluded from the main tsconfig** (it imports the `.open-next/worker.js` build artifact), so plain `npx tsc --noEmit` never checks it — a missing import there once reached production (`ReferenceError: mediaCacheLimitsFrom is not defined`). Validate it with `npx tsc -p tsconfig.worker.json --noEmit` after a build (`npm run preview` at least once, so `.open-next/` exists).
- **Cloudflare Workers runtime.** Never use Node-only globals in runtime code (`nodejs_compat` is enabled, but stay portable). Bindings are read with `getCloudflareContext()` — never `process.env`.
- **No secrets in git.** `wrangler.toml` holds public vars, bindings and resource IDs only. Secrets go through `wrangler secret put`.
- **Validate before finishing:** `npx tsc --noEmit && npx tsc -p tsconfig.worker.json --noEmit && npx eslint . && npx vitest run`. All three must stay green. If you add/remove a route file, run `npx next typegen` first (stale `.next/types` breaks `tsc`).

## Commands

```bash
npm run dev          # plain Next.js dev server (no CF bindings)
npm run test         # vitest
npm run lint         # eslint
npm run preview      # opennextjs-cloudflare build + wrangler dev (local CF runtime)
npm run deploy       # opennextjs-cloudflare build + wrangler deploy
npm run db:migrate   # apply lib/db/schema.sql to the remote D1 DB
node scripts/upgrade-schema.mjs        # idempotent upgrade for existing instances
node scripts/upgrade-schema.mjs --local
```

Wrangler needs the D1 name explicitly:

```bash
npx wrangler d1 execute <db> --remote --json --command="EXPLAIN QUERY PLAN SELECT ..."
```

`--file=` is broken in this environment (`fetch failed`); always use `--command=` for one statement and `scripts/upgrade-schema.mjs` for batches/backfills.

## Architecture

| Concern | Where |
|---|---|
| Next.js App Router pages | `app/` (server & client components) |
| Mastodon-compatible REST API | `app/api/**/route.ts` |
| ActivityPub federation (inbox/outbox, actors, security, queue) | `lib/activitypub/` |
| Mastodon serializers + status ID encoding | `lib/mastodon/` |
| D1 queries + row mappers | `lib/db/index.ts`; schema `lib/db/schema.sql`; reset `lib/db/drop.sql` |
| Types (actors, objects, env, calls) | `lib/types/` |
| AI moderation ("Guardian") | `lib/moderation/` |
| Streaming / WebRTC Durable Objects | `lib/streaming/`; exported by `src/worker.ts` |
| i18n (10 locales) | `lib/locales/*.json` + `lib/i18n.tsx` |
| Instance brand context | `lib/instance-context.tsx` |
| Worker entry (wrangler `main`) | `src/worker.ts` |
| Edge middleware / rewrites | `middleware.ts` |
| Migrations + idempotent upgrade | `scripts/*.sql`, `scripts/upgrade-schema.mjs` |
| Limits (env-overridable) | `lib/constants.ts` (`resolveLimits`) |

### Bindings (`wrangler.toml` → `lib/types/env.ts`)

`DB` (D1) · `KV` (cache/markers) · `R2` (media) · `DELIVERY_QUEUE` (AP fan-out + DLQ) · `TIMELINE_STREAM`, `CALL_SIGNALING` (DOs) · `AI` · `VECTORIZE` (optional) · `EMAIL`. Cron `* * * * *` runs maintenance + Guardian patrol.

```ts
import { getCloudflareContext, json, notFound, unauthorized, badRequest } from "@/lib/cf";
const { env } = getCloudflareContext();
```

## Data layer (D1 / SQLite) — lessons learned the hard way

- **`lib/db/schema.sql` is the single source of truth.** `scripts/upgrade-schema.mjs` replays every `CREATE TABLE/INDEX IF NOT EXISTS` from it, so operators using the script alone stay current. Still add numbered `scripts/NNN-*.sql` files to document each change; update `lib/db/drop.sql` (generated, children before parents) when adding tables.
- **Measure before optimizing.** Use `EXPLAIN QUERY PLAN` against the remote DB. Confirm the plan uses the index and that `rows_read` drops. `USE TEMP B-TREE FOR ORDER BY` over tens of thousands of rows is the usual smell.
- **SQLite/D1 does not use expression indexes for `ORDER BY`**, and partial indexes whose predicate uses `IN (...)` are not matched by the planner. Don't design around them.
- **`col IN (...)` on the leading index column defeats ordered scans.** Split hot queries into one branch per value with `UNION ALL` (each branch gets its own ordered index scan) and, when the planner still prefers a range index, force it with `INDEXED BY idx_name`.
- **Don't `ORDER BY` a computed expression over a big table.** Denormalize and maintain on writes:
  - `objects.engagement` = favourites + reblogs + replies (kept in sync in every counter mutation; index `idx_objects_trending`).
  - `actors.last_status_at` = max public status date (maintained by `createObject`, `deleteObject`, remote upsert and the scheduled-publish cron; index `idx_actors_discoverable_active`; directory ranks by it).
  - `idx_objects_url` backs the Like/Announce URL fallback.
- **Correlated `MAX(published)` subqueries per row are a smell** — precompute on `actors` instead.
- **D1 bind limit ≈ 100.** For long `IN` lists pass a JSON array and use `json_each(?)`.
- **List timelines** (`getListTimeline`) prefilter the (small) member set minus blocked actors/domains, then run one ordered scan per visibility (`UNION ALL` + `INDEXED BY idx_objects_vis_published`). Never join `list_accounts` with `visibility IN (...)` + correlated `NOT EXISTS`: that plan scans every public object and sorts it (~8M rows/request in production analytics).
- **Large backfills must be batched**: single full-table `UPDATE`s hit `SQLITE_NOMEM`. Walk an id cursor and chunk statements by bytes in `upgrade-schema.mjs`; guard one-shot migrations with `instance_settings` markers.
- **Never `DROP` stateful tables in the upgrade script** (`delivery_rejections` was wiped every run once — don't repeat that).
- Wrap queries in `try/catch` with a migration pointer when columns may be missing on old DBs (`last_status_at`, `quote_id`, …).
- `lib/db/index.ts` has shared SQL constants (`PUBLIC_STATUS_TYPE_SQL`) and helpers (`isAcceptedFollower`, `countActorPublicStatuses`, `deleteRemoteActorData`). Reuse them; don't inline the type list or fire raw ownership-less deletes.

## Federation rules

- **All outbound delivery goes through the queue** (`enqueueDeliveries`; fan-outs larger than 100 are chunked by count *and* byte budget, each chunk is retried and only a persistently failing chunk falls back to direct delivery — never the whole recipient list). `deliverToInbox` is only reachable from `lib/activitypub/queue.ts` (fallback when no binding/`sendBatch` throws) and the worker's `deliverOne` consumer. Never call it from a handler. The DLQ (`cf-ap-delivery-dlq`) has its own consumer that records failures in KV (`dlq:delivery:*`, 30 days) and acks.
- **Inbound signatures**: `verifySignature` requires `(request-target)` and, when there is a body, `digest` **inside the signed-headers list**; the inbox routes also require a valid `Date` (12h window). Only RSA/hs2019 is accepted.
- **Actor id binding**: never cache an actor document whose `id` differs from the URL that was fetched; `upsertRemoteActor` must never update `is_local = 1` rows (cache-poisoning guard).
- **Domain blocks** (`instance_domain_blocks`): `severity = 'suspend'` drops the activity; `'silence'` processes it but strips media (`reject_media`) and ignores forwarded Flags (`reject_reports`).
- **Instances that block us / unreachable**: the queue consumer records every delivery failure in `delivery_rejections` (permanent 400/401/403/404/410/422, or `status = 0` for network/timeout/5xx with the actual HTTP status in `last_error`); a later successful delivery sets `last_ok_at`. `/api/v1/graph` exposes `status = 403` as `blockedBy` ("Blocks you") and `status = 0` as `unreachable`, both while `last_ok_at IS NULL OR last_at > last_ok_at`. A permanent HTTP status overrides a transient 0. The circuit breaker skips hosts that failed 3 times in a row (1h).
- **Dedup**: `processInboxActivity` records each signed `activity.id` in `activities` (`INSERT OR IGNORE`) and skips replays. Record only after signature/ownership checks.
- **Ownership**: embedded objects in Announce/Update must be authored by the signer or share origin; MLS mutations are actor-scoped (`setMlsKeyPackageActive`, `deleteMlsKeyPackageByObjectId`, `deleteMlsMessagesByObjectId`); call events are validated against the `call:<id>` KV session from the `CallOffer`.
- **`Delete` cleanup** lives in `deleteObject` (notifications, conversation pointer, parent `replies_count`/`engagement`) and `deleteRemoteActorData` (`Delete{Actor}` purge). `Undo{Accept}` removes followers; `Undo{Follow}` only decrements accepted follows.
- **Remote accounts require auth**: `/api/v1/accounts/:id` (401 for anonymous remote ids, cached or not), remote `lookup` handles, `/api/v1/accounts/:id/statuses`, `/api/v1/accounts/:id/collections`, the `/users/remote` page, `/api/v2/search` remote resolution, `/api/v1/statuses/:id` on-demand resolution and `/api/v1/e2ee/resolve`. Local profiles stay public. Discoverable collection pages (`/api/v1/collections/:id` and `/collections/:id`) stay public even for remote collections.
- **Remote handle URLs are link-outs, never resolution**: `/@user@domain` is rewritten by `middleware.ts` to `/redirect?url=…` (Mastodon's "you are about to leave" interstitial pointing at `https://domain/@user`); direct `/users/user@domain` visits redirect there too. Same-instance handles (`/@alice@cf-ap.com`) stay local.
- **Outbox**: `buildOrderedCollectionPage(collectionId, pageId, items, nextId?, prevId?)`; `totalItems` counts only public statuses; cursor advances with the last fetched status regardless of visibility; suspended actors 404. Collections are CORS-enabled via `middleware.ts`.
- **Collections** (FEP-7aa9): local actors advertise `featuredCollections` and serve `/users/:username/collections` (+ `/collections/:id`, `/feature_authorizations/:itemId` for local item accounts). Mutations enqueue `Update`/`Delete{FeaturedCollection}` to followers. Remote collections are cached by `syncRemoteCollections` (KV throttle 1h; forced by inbound `Update{FeaturedCollection}`, removed by `Delete`) via the account/collections routes; `collections.url` stores the remote web URL and `collectionHref()` picks the right link. Caption/description edits on remote collections are only mirrored on sync.
- **Scheduled statuses** publish through `createObject` + `enqueueDeliveries` + streaming (public/home) and link pending media (`pending_media:` KV, TTL extended at schedule time). Don't hand-roll inserts there.
- **Consume or cancel every outbound response body** (`discardBody` in `lib/http.ts`): leaving bodies unread stalls the runtime's in-flight fetch pool and triggers "A stalled HTTP response was canceled to prevent deadlock" (deliveries/push only need the status; R2 rejects streamed uploads without a known length — use `FixedLengthStream`, and cancel the stream if `R2.put` fails).
- **SSRF**: run `safeFetch` (or at least `validateOutboundUrl`) before every outbound request. `safeFetch` re-validates each redirect hop and bounds the whole exchange with a timeout; it blocks private/metadata/CGNAT/multicast ranges and internal suffixes (DNS rebinding is out of scope inside a Worker).

### Federation engine (instances)

- **Registry + metadata**: `instances` (one row per remote domain) stores NodeInfo metadata and availability. `lib/activitypub/instances.ts` fetches `/.well-known/nodeinfo` (2.1 → 2.0 → 1.0, SSRF-guarded) with a `/api/v2/instance` fallback; the cron refreshes due instances (`INSTANCE_REFRESH_BATCH`/`_DAYS`) and, daily, expires the metadata of dormant instances (`INSTANCE_DORMANT_DAYS`, kept if a local account follows them). `/api/v1/instance/peers` reads the registry.
- **Availability (Mastodon `DeliveryFailureTracker`)**: failures on 7 distinct UTC days mark a host `unavailable` and set KV `inst:down:<domain>` (24h) so the queue consumer skips it without a D1 read; any success clears it — outbound delivery or a **signed inbound activity** (`recordInstanceInboundActivity`, KV-throttled last_seen). This is the only recovery path for hosts we stopped delivering to.
- **Delivery target**: `collectFollowerInboxes` prefers `endpoints.sharedInbox` (stored in `actors.shared_inbox`). New/updated actors populate it from their AP document; the cron backfills the actors that matter (`backfillRemoteSharedInboxes`, `SHARED_INBOX_BATCH` per tick, failures parked in KV `actor:shared:skip:*` for 7 days). Per-user inboxes are noisier and time out on some implementations (GoToSocial…).
- **Retries (Mastodon `ActivityPub::DeliveryWorker`)**: `max_retries = 16` in `wrangler.toml`, delay `(attempts^4)+15+jitter` capped at 24h (`deliveryRetryDelay`), `Retry-After` honored for 429/503; permanent 4xx ack; exhausted messages go to the DLQ.
- **Admin**: `/admin/instances` + `/api/v1/admin/instances` (list/filter, add/refresh, reset availability, suspend/unsuspend, purge all cached actors of a domain). Suspend sets the KV `inst:paused:<domain>` marker that the queue consumer checks (delivery stops); purge uses `deleteRemoteActorData`; actions are written to `moderation_log` with `target_type = 'instance'`.

### Remote media cache (R2)

- Federated resources (status attachments, profile avatars/headers) are cached in R2 (`media_cache` table, `cache/media/<sha256>.<ext>` keys) and served from `/api/media/...`, so clients stop hitting the origin server. `attachments.remote_url` / `actors.avatar_url` keep the origin; the served `url` / `avatar_cache_url` point at the cached copy (serializers prefer the cache URL). Entries are keyed by source URL and `cached_url` is applied to EVERY attachment/actor referencing that URL (the same file backs several posts), and enqueueing an already-cached URL rewrites new references on the spot without waiting for the cron.
- **No origin leakage while the cache is on**: freshly ingested remote statuses are held out of feeds (`objects.media_pending = 1`) until their attachments **and the author's avatar** are in R2 (or permanently failed); `serializeStatus` strips media/card for held rows so no path ever emits origin URLs. The cron releases (`releaseMediaPendingObjects`) and announces them as **new** statuses (`broadcastStatusCreatedToAudience`, public/home/lists) once cached. Cards only attach when their image is cached or failed. Statuses with no remote media are unaffected, and the flag is cleared when the cache is disabled. A safety valve (`MEDIA_CACHE_MAX_HOLD_MINUTES`, 30 min, 0 disables) releases older statuses anyway so a degraded cache can never hide content forever.
- Config (all env vars, cache ON by default): `MEDIA_CACHE_ENABLED`, `MEDIA_CACHE_DAYS` (7, attachments), `MEDIA_CACHE_PROFILE_DAYS` (30, profiles of accounts with a local follow relation are kept), `MEDIA_CACHE_MAX_BYTES` (10 GiB, oldest evicted first), `MEDIA_CACHE_MAX_OBJECT_BYTES` (40 MB), `MEDIA_CACHE_FETCH_BATCH` (5/tick), `MEDIA_CACHE_USER_AGENTS` (overrides the whole list; by default the bot UA — built from `INSTANCE_VERSION`/`INSTANCE_URL` — is tried first, then browser UAs; non-media types, SVG and oversized bodies are rejected).
- Hooks: `enqueueMediaCache` in `handleCreate`/`saveObjectAttachments`/`storeObjectAttachments`/remote featured items and in `upsertRemoteActor` for avatars/headers. Cron runs `maintainMediaCache` (expiry + byte-budget eviction + orphan cleanup) FIRST, then drains the queue (`processMediaCacheQueue`), releases held statuses, and leaves the optional `backfillMediaCache` and the expensive one-shot reference repair LAST (the repair is throttled to one attempt every 10 min and walks `attachments` in 20k-rowid windows with its cursor in `instance_settings`) — a slow optional step must never delay the queue drain. Expiry, eviction and purge **restore every origin reference before deleting the row** (`resetMediaCacheReferences`: `attachments.url = remote_url`, `actors.*_cache_url = NULL`, `preview_cards.image_cache_url`/`card_json` back to the origin image) — deleting the R2 copy while references kept pointing at `/api/media/...` produced dead avatars/attachments (849 on cf-ap). A marker-guarded one-shot cron repair (`repairMediaCacheReferences`, `media_cache_refs_repaired`) heals references the old code already broke; run `node scripts/upgrade-schema.mjs` so the `media_cache.cached_url` / `attachments.remote_url` / `actors.avatar_url` / `header_url` indexes exist first. Resetting `attachments.url` back to the origin can collide with the unique `(object_id, url)` index when one object holds two rows for the same source (one already at the origin, one stale cached): the apply/reset/repair paths dedupe those rows (keep the origin-serving one) before rewriting — the old plain UPDATE failed with `SQLITE_CONSTRAINT_UNIQUE` and aborted maintenance. Maintenance also drops entries whose owner is gone (deleted status/attachment, unlinked preview card, deleted or replaced actor avatar) — an avatar of a live account is never touched, it only goes when the actor row does. The orphan sweep probes only indexed columns (`idx_attachments_remote_url`/`idx_attachments_url`, `idx_actors_avatar_url`/`idx_actors_header_url`, `idx_preview_cards_image`): an `OR` over two non-indexed columns full-scanned `attachments` per cache entry and tripped D1's CPU limit (the admin media_cache GET started failing). Eviction is FIFO (`fetched_at ASC`, oldest replaced first) with a 500 MB/tick byte budget — enough to drain a large overage — and `MEDIA_CACHE_MIN_ENTRIES` (20) is a floor: the cache is never wiped automatically (only the full-admin purge wipes). The byte total is `SUM(media_cache.size)` in D1 (never a KV counter: concurrent updates lost writes); downloads stream straight into R2 with a size-capped `TransformStream` and a bounded pool (8 concurrent) — buffering 50 bodies at once (up to `MEDIA_CACHE_MAX_OBJECT_BYTES` each) exceeded the Worker memory limit; the auto-delete stage is capped at 500 objects/tick because `objects.raw` is a full AP document. Fetching runs as a **rolling window**: `maintainMediaCache` evicts FIFO every tick and only a runaway overage (>2× `MEDIA_CACHE_MAX_BYTES`) pauses fetching, so the queue never stalls at the (normal) saturated steady state; backfill pauses while over budget. Admin API: `GET / POST / DELETE /api/v1/admin/media_cache` (`POST` runs `enforceMediaCacheBudget` until under the limit, bounded to 60 s, and reports the counts). `mediaCacheLimitsFrom(instanceLimits)` is the only bridge between `resolveLimits()` (fields prefixed `mediaCache*`) and the cache module: the cron once passed the raw limits object, every field fell back to defaults (10 GiB) and `MEDIA_CACHE_MAX_BYTES` was silently ignored. `MEDIA_CACHE_MIN_ENTRIES=0` is accepted (uses `nonNegativeNum`).

### Link previews (Mastodon PreviewCard)

- A status with a link gets a Mastodon-style preview card: the **first external URL** (hashtag/mention links and own-instance links skipped) is queued in `link_preview_queue` and crawled by the cron (`lib/link-preview.ts`), like Mastodon's `FetchLinkCardService`. Statuses with media or a quote are skipped.
- The crawl tries **oEmbed first** (JSON discovery via `<link type="application/json+oembed">`; `rich` is rejected like Mastodon) and falls back to **OpenGraph/Twitter Card/JSON-LD** (`og:title`/`og:description`/`og:image`/`og:site_name`/`canonical`/`article:published_time`); `twitter:player` becomes a sanitized `<iframe>` (`type=video`, https-only, scripts dropped). Outbound requests use `fetchWithUserAgents` (`lib/media/fetch.ts`) — the **same user agents and fallback** as the media cache — and `safeFetch` (SSRF) for every hop.
- Cards live in `preview_cards`, keyed by the URL as posted, **shared by every status** linking to it and refreshed after `LINK_PREVIEW_DAYS`. Unreachable/no-metadata URLs are negative cached (`status='failed'`, 7 days).
- Each status stores a snapshot (`objects.card_id`/`objects.card_json`) so `serializeStatus` emits `card` with **no extra queries** anywhere (timelines, notifications, streaming re-serializations, quote). Editing a status clears/re-crawls the card only when its first link changed.
- With the media cache enabled the preview image is queued there too (`media_cache.target_type = 'card'`); when it becomes ready, `preview_cards.image_cache_url` and every `objects.card_json` are updated in place (`json_set`). Env: `LINK_PREVIEW_ENABLED`, `LINK_PREVIEW_FETCH_BATCH`, `LINK_PREVIEW_DAYS`, `LINK_PREVIEW_MAX_BYTES`; `linkPreviewLimitsFrom(instanceLimits)` is the typechecked bridge from `resolveLimits()`.
- When the card is attached the cron broadcasts `status.update` (public channels, home feeds of the author's local followers — including the author — and every list containing the author, via `broadcastStatusRefresh`) so it appears **without a manual refresh**; the client merge (`mergeStatusUpdate`) preserves viewer-specific fields (`favourited`, `reblogged`, `bookmarked`, `muted`, `pinned`, `filtered`) because the shared payload cannot know them. The status detail page also handles `status.update`. Include the poll in the refresh payload: a poll status with a link would otherwise lose its options on update.
- The web UI (`components/StatusCard.tsx`) renders the card image (blurred while the status is sensitive, same reveal button as media) + provider/title/description, linking out with `rel="nofollow noopener noreferrer"`. External iframes are not rendered (CSP `frame-src` is Turnstile-only); `card.html` is still exposed for Mastodon clients.

### Security invariants (audited)

- **Actor trust**: never cache a fetched actor document whose `id` differs from the URL fetched — call `upsertRemoteActor(db, doc, expectedId)` at every fetch site. Server-side fetch helpers must check before upserting.
- **Object attribution**: remote objects may only be stored when `attributedTo` shares the object IRI's host and is not a local actor (`handleCreate`, `handleLike`, `handleFlag`, `fetchAndCacheRemoteStatus`, `persistRemoteNote`).
- **Visibility**: every route reading an object by id gates with `canViewStatus(obj, viewerId, isAcceptedFollower(db, viewerId, obj.actorId))` — including source/history/translate/favourited_by/reblogged_by/pin/account statuses. `getFollow` ignores state and must never be used for visibility.
- **Registration**: always `email_verified = 0` + confirmation email (web and API); the API still returns a Mastodon-shaped token but it is unusable until confirmed. Local actor ids come from `getBaseUrl(env)`, never the request Host.
- **Canonical email (anti-abuse)**: `lib/canonical-email.ts` collapses `user+tag@domain` and dotted local parts for EVERY domain (googlemail≡gmail). `actors.canonical_email_hash` stores sha256(canonical), `canonical_email_blocks` denies a mailbox, and the registration flow rejects duplicates of an existing mailbox, auto-blocks after 3 attempts from the same mailbox (24h KV window) and audits it (`registration_blocked`). Admin API: `/api/v1/admin/canonical_email_blocks` (full admin).
- **OAuth**: authorization codes require matching `client_id` + `redirect_uri` and PKCE whenever a challenge was issued; scopes are clamped to the app's registered scopes; an empty scope is not full access; a session cookie is only set for same-origin logins.
- **Admin roles**: `requireFullAdmin` guards role changes, instance settings, federation rules, audit-log wipes and instance mutations; never demote/delete the last admin. Account actions (suspend/silence/approve/delete/reject) go through `accountActionGuard` (`lib/admin/account-guards.ts`): reserved actor immutable, no self-actions, admin targets need a full admin, and last-administrator access can't be removed (`countUsableAdmins` ignores the credential-less Guardian actor). Privileged mutations (roles, reports, domain blocks, settings, announcements, instances, log edits) write `moderation_log`.
- **Captcha (Turnstile)**: `enforceTurnstilePolicy` requires a valid token on registration, web login and password recovery **whenever `TURNSTILE_SECRET` is configured** (it skips only when no secret is set, and never treats a missing token as verified). The old `if (turnstileToken) verify(...)` check was a trivial bypass: omitting `cf-turnstile-response` skipped the challenge. The login password grant skips the captcha only for a registered OAuth app with matching `client_id`+`client_secret` (API clients); failed passwords increment an IP-independent per-account lockout (10/15 min, cleared on success). `expectedHostname` always comes from `getBaseUrl(env)`, never the request Host.
- **OAuth scopes**: `read` is enforced on GET/HEAD and `write` on mutations; `push` on push subscriptions. Scopes are clamped to the app's registered scopes (`clampScope`) on every issuance path — registration included — and an empty scope is not full access. Promoting moves one step (user → moderator → admin) and promoting an admin is a no-op — the old promote silently downgraded admins. Role changes are written to `moderation_log` (`promoted`/`demoted`) and the reserved instance actor's role is immutable.
- **Streaming**: list channels are owner-checked in the worker (dynamic re-subscribe limited to the socket's initial list) and only public/unlisted statuses are broadcast to them; streaming tokens honor the same suspension/verification gates as REST.
- **Profile-field verification** is HTTPS-only and KV-throttled: `verifyAccountFields` skips plain-http field values silently, remote accounts are retried at most every 6h and re-verified after 30 days (badge revocation). An `https` field whose page redirects to plain HTTP is blocked by `safeFetch` (`[federation] Blocked outbound request …` in the logs) — expected, not an attack.
- **Browser-facing API errors**: return a stable `error_code` (i18n key) next to the English `error`/`error_description`; the web forms translate it with the existing client i18n (`translateKey` in `lib/i18n.tsx`). Never ship untranslated user-facing strings.
- **Remote HTML** goes through `sanitizeFediverseHtml` (control chars stripped, http(s)-only media `src`); remote bodies are size-capped (2 MB) before parsing.

## Code conventions

- **Path alias** `@/*` → repo root. Always import with `@/`.
- **API routes**: exported async `GET`/`POST`/… typed `(request: NextRequest, { params }: { params: Promise<{ id: string }> })`. Use `json()`/`notFound()`/`unauthorized()`/`badRequest()` from `@/lib/cf`.
- **Streaming**: components never open a raw WebSocket — `lib/streaming/use-timeline-stream.ts` is a shared, ref-counted manager: one socket per (stream + extra params) reused by every listener, kept alive 30s after the last unmount so tab switches reconnect nothing, and `user:notification` is served from the `user` socket (home channel already forwards notifications), filtered to notifications only.
- **Timelines**: client feeds share `useTimelineCache` + `lib/streaming/timeline-cache.ts`. Always merge with `mergeTimelineItems` (dedup + newest-first by `created_at`, the same field the server orders by) — never prepend streamed statuses blindly (a late federated post would jump to the top). A failed/empty page must never replace cached items, and `seenIds` is always derived from the visible items. Timeline `fetchPage` throws on `!res.ok`; the hook keeps the current feed and retries.
- **Auth**: `getAuthenticatedActor(request, env.DB)` from `@/lib/auth` (cookie `auth_token` or Bearer; client `getToken()` from `@/lib/client-api`). It rejects suspended, **email-unconfirmed** and pending-approval local accounts. Mutating requests require the `write` scope (`read`-only tokens are rejected). Self-service registration (`POST /api/v1/accounts`) always sends the confirmation email and creates the account with `email_verified = 0` — the presence of a Turnstile token must never auto-verify (API clients skip the captcha, not the email). API registrations still receive a token (Mastodon shape) but it is unusable until confirmed. Admin: `requireAdmin(request, env)` from `@/lib/admin-auth` (role + optional `ADMIN_TOKEN`).
- **i18n**: 10 locale files in `lib/locales/`. `t` from `useLocale()` is a Proxy — use `t.some_key`; interpolate with `.replace("{var}", value)`. **Every key must exist in all 10 locales with identical key sets** — never hardcode user-facing strings.
- **Brand**: read `useInstanceTitle()` / `INSTANCE_TITLE`; metadata comes from `generateMetadata()` in `app/layout.tsx` and the PWA manifest from `app/manifest.webmanifest/route.ts`. Don't hardcode the instance name in UI.
- **Limits**: read `resolveLimits(env)` (`lib/constants.ts`) instead of hardcoding page sizes/char limits; new limits get a constant, an env override and a comment in `wrangler.toml`.
- **Images**: custom loader in `next.config.ts`; prefer `next/image`. For non-square remote avatars force `width`/`height` + `objectFit: "cover"` inline (Tailwind preflight overrides attributes).
- **Remote content**: render via `renderRemoteContent`/helpers in `lib/activitypub/content.ts`; never inject raw remote HTML.
- **Objects**: set `updated_at = published` explicitly on insert (the column DEFAULT uses a different format and would mark new posts as edited).
- **Style**: no comments unless they explain *why*; TypeScript strict; `setX`/`handleX`/`fetchX` naming; admin pages keep the emoji prefix in nav/titles.

## Testing

- Vitest + jsdom (`globals: true`), tests under `lib/__tests__/` and `lib/activitypub/__tests__/`.
- API-route tests mock `@/lib/cf`'s `getCloudflareContext` and the DB chain with `vi.hoisted`; match the existing mock style.
- Inbox/federation tests use an in-memory `node:sqlite` D1 adapter that loads `lib/db/schema.sql` (so schema changes are exercised) and mock `@/lib/streaming/broadcast` + `@/lib/push`.
- When touching security, add tests: `lib/activitypub/__tests__/security.test.ts` (signatures, SSRF) and `queue.test.ts` (queue vs fallback). When touching call handling, seed the `call:<id>` KV session in the test context.

## Gotchas that have bitten before

- `middleware.ts` must stay Edge-compatible (only `next/server`). A file named `proxy.ts` would run on Node — don't rename it.
- `src/worker.ts` is wrangler's `main`: wraps OpenNext, exports the DO classes, and adds the queue consumer (incl. DLQ), WebSocket upgrades for `/api/v1/streaming` and `/api/v1/calls/:id/ws`, and cron. Intercept those **before** `openNextDefault.fetch`.
- **Never reference DOM globals in Workers code** (`status`, `name`, `origin`, `top`, `event`…): with `lib.dom` in tsconfig TypeScript resolves them and `tsc` stays green, but at runtime in a Worker they throw (`ReferenceError`) — a surrounding `try/catch` can swallow it silently (a `status` typo made `broadcastObjectDelete` skip every list channel for months). Either fix, and prefer `obj.visibility`, never bare `status`.
- Cron phase drifts: `executeScheduled` aligns to the top of the minute; never assume `:00`.
- `getFollow` does **not** filter by state — use `isAcceptedFollower` for followers-only visibility.
- Removing local accounts must clean `oauth_tokens`, `activities` and `moderation_log` (no FKs) and federate a `Delete` tombstone (see `app/api/v1/accounts/delete/route.ts` and the admin DELETE route).
- Never re-ingest already-stored objects to change rendering — serializers read `objects.raw`, so rendering fixes are backward-compatible without migration.
- Web Push is silenced while a focused tab reports presence: the client heartbeats `POST /api/v1/push/presence` (D1 `push_subscriptions.present_until`, 120s — D1, not KV, so unfocusing is strongly consistent across colos) and `deliverPushNotification` skips while it is in the future. Do **not** instead skip `showNotification` in `public/sw.js` — Chrome substitutes "This site has been updated in the background" and burns the per-origin push budget.
