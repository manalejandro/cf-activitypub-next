<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# CF ActivityPub — Agent Instructions

A Mastodon-compatible ActivityPub server running entirely on Cloudflare Workers via **Next.js 16 App Router + @opennextjs/cloudflare**. There is no Node.js server, no Docker, no database server — everything is a Cloudflare binding. This file is the working contract for anyone (human or AI) changing this repo.

## Ground rules

- **Next.js 16** (see the warning block above). Route handlers receive `{ params }` as a `Promise` and must `await` it. Do not assume your training data's API; read `node_modules/next/dist/docs/` first.
- **Cloudflare Workers runtime.** Never use Node-only globals in runtime code (`nodejs_compat` is enabled, but stay portable). Bindings are read with `getCloudflareContext()` — never `process.env`.
- **No secrets in git.** `wrangler.toml` holds public vars, bindings and resource IDs only. Secrets go through `wrangler secret put`.
- **Validate before finishing:** `npx tsc --noEmit && npx eslint . && npx vitest run`. All three must stay green. If you add/remove a route file, run `npx next typegen` first (stale `.next/types` breaks `tsc`).

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
- **SSRF**: run `safeFetch` (or at least `validateOutboundUrl`) before every outbound request. `safeFetch` re-validates each redirect hop and bounds the whole exchange with a timeout; it blocks private/metadata/CGNAT/multicast ranges and internal suffixes (DNS rebinding is out of scope inside a Worker).

### Federation engine (instances)

- **Registry + metadata**: `instances` (one row per remote domain) stores NodeInfo metadata and availability. `lib/activitypub/instances.ts` fetches `/.well-known/nodeinfo` (2.1 → 2.0 → 1.0, SSRF-guarded) with a `/api/v2/instance` fallback; the cron refreshes due instances (`INSTANCE_REFRESH_BATCH`/`_DAYS`) and, daily, expires the metadata of dormant instances (`INSTANCE_DORMANT_DAYS`, kept if a local account follows them). `/api/v1/instance/peers` reads the registry.
- **Availability (Mastodon `DeliveryFailureTracker`)**: failures on 7 distinct UTC days mark a host `unavailable` and set KV `inst:down:<domain>` (24h) so the queue consumer skips it without a D1 read; any success clears it — outbound delivery or a **signed inbound activity** (`recordInstanceInboundActivity`, KV-throttled last_seen). This is the only recovery path for hosts we stopped delivering to.
- **Delivery target**: `collectFollowerInboxes` prefers `endpoints.sharedInbox` (stored in `actors.shared_inbox`). New/updated actors populate it from their AP document; the cron backfills the actors that matter (`backfillRemoteSharedInboxes`, `SHARED_INBOX_BATCH` per tick, failures parked in KV `actor:shared:skip:*` for 7 days). Per-user inboxes are noisier and time out on some implementations (GoToSocial…).
- **Retries (Mastodon `ActivityPub::DeliveryWorker`)**: `max_retries = 16` in `wrangler.toml`, delay `(attempts^4)+15+jitter` capped at 24h (`deliveryRetryDelay`), `Retry-After` honored for 429/503; permanent 4xx ack; exhausted messages go to the DLQ.
- **Admin**: `/admin/instances` + `/api/v1/admin/instances` (list/filter, add/refresh, reset availability, suspend/unsuspend, purge all cached actors of a domain). Suspend sets the KV `inst:paused:<domain>` marker that the queue consumer checks (delivery stops); purge uses `deleteRemoteActorData`; actions are written to `moderation_log` with `target_type = 'instance'`.

## Code conventions

- **Path alias** `@/*` → repo root. Always import with `@/`.
- **API routes**: exported async `GET`/`POST`/… typed `(request: NextRequest, { params }: { params: Promise<{ id: string }> })`. Use `json()`/`notFound()`/`unauthorized()`/`badRequest()` from `@/lib/cf`.
- **Timelines**: client feeds share `useTimelineCache` + `lib/streaming/timeline-cache.ts`. Always merge with `mergeTimelineItems` (dedup + newest-first by `created_at`, the same field the server orders by) — never prepend streamed statuses blindly (a late federated post would jump to the top). A failed/empty page must never replace cached items, and `seenIds` is always derived from the visible items. Timeline `fetchPage` throws on `!res.ok`; the hook keeps the current feed and retries.
- **Auth**: `getAuthenticatedActor(request, env.DB)` from `@/lib/auth` (cookie `auth_token` or Bearer; client `getToken()` from `@/lib/client-api`). Mutating requests require the `write` scope (`read`-only tokens are rejected). Admin: `requireAdmin(request, env)` from `@/lib/admin-auth` (role + optional `ADMIN_TOKEN`).
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
- Cron phase drifts: `executeScheduled` aligns to the top of the minute; never assume `:00`.
- `getFollow` does **not** filter by state — use `isAcceptedFollower` for followers-only visibility.
- Removing local accounts must clean `oauth_tokens`, `activities` and `moderation_log` (no FKs) and federate a `Delete` tombstone (see `app/api/v1/accounts/delete/route.ts` and the admin DELETE route).
- Never re-ingest already-stored objects to change rendering — serializers read `objects.raw`, so rendering fixes are backward-compatible without migration.
- Web Push is silenced while a focused tab reports presence: the client heartbeats `POST /api/v1/push/presence` (D1 `push_subscriptions.present_until`, 120s — D1, not KV, so unfocusing is strongly consistent across colos) and `deliverPushNotification` skips while it is in the future. Do **not** instead skip `showNotification` in `public/sw.js` — Chrome substitutes "This site has been updated in the background" and burns the per-origin push budget.
