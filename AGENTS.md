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

The repo manages several production instances (e.g. `cf-ap`, `fedisocial`). Wrangler needs the D1 name explicitly:

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
- **Large backfills must be batched**: single full-table `UPDATE`s hit `SQLITE_NOMEM`. Walk an id cursor and chunk statements by bytes in `upgrade-schema.mjs`; guard one-shot migrations with `instance_settings` markers.
- **Never `DROP` stateful tables in the upgrade script** (`delivery_rejections` was wiped every run once — don't repeat that).
- Wrap queries in `try/catch` with a migration pointer when columns may be missing on old DBs (`last_status_at`, `quote_id`, …).
- `lib/db/index.ts` has shared SQL constants (`PUBLIC_STATUS_TYPE_SQL`) and helpers (`isAcceptedFollower`, `countActorPublicStatuses`, `deleteRemoteActorData`). Reuse them; don't inline the type list or fire raw ownership-less deletes.

## Federation rules

- **All outbound delivery goes through the queue** (`enqueueDeliveries`). `deliverToInbox` is only reachable from `lib/activitypub/queue.ts` (fallback when no binding/`sendBatch` throws) and the worker's `deliverOne` consumer. Never call it from a handler. The DLQ (`cf-ap-delivery-dlq`) has its own consumer that records failures in KV (`dlq:delivery:*`, 30 days) and acks.
- **Inbound signatures**: `verifySignature` requires `(request-target)` and, when there is a body, `digest` **inside the signed-headers list**; the inbox routes also require a valid `Date` (12h window). Only RSA/hs2019 is accepted.
- **Actor id binding**: never cache an actor document whose `id` differs from the URL that was fetched; `upsertRemoteActor` must never update `is_local = 1` rows (cache-poisoning guard).
- **Domain blocks** (`instance_domain_blocks`): `severity = 'suspend'` drops the activity; `'silence'` processes it but strips media (`reject_media`) and ignores forwarded Flags (`reject_reports`).
- **Dedup**: `processInboxActivity` records each signed `activity.id` in `activities` (`INSERT OR IGNORE`) and skips replays. Record only after signature/ownership checks.
- **Ownership**: embedded objects in Announce/Update must be authored by the signer or share origin; MLS mutations are actor-scoped (`setMlsKeyPackageActive`, `deleteMlsKeyPackageByObjectId`, `deleteMlsMessagesByObjectId`); call events are validated against the `call:<id>` KV session from the `CallOffer`.
- **`Delete` cleanup** lives in `deleteObject` (notifications, conversation pointer, parent `replies_count`/`engagement`) and `deleteRemoteActorData` (`Delete{Actor}` purge). `Undo{Accept}` removes followers; `Undo{Follow}` only decrements accepted follows.
- **Remote accounts require auth**: `/api/v1/accounts/:id`, `/lookup`, account statuses, `/api/v2/search` remote resolution, `/api/v1/statuses/:id` on-demand resolution and `/api/v1/e2ee/resolve` all return 401 for anonymous requests. Local content stays public.
- **Outbox**: `buildOrderedCollectionPage(collectionId, pageId, items, nextId?, prevId?)`; `totalItems` counts only public statuses; cursor advances with the last fetched status regardless of visibility; suspended actors 404. Collections are CORS-enabled via `middleware.ts`.
- **Scheduled statuses** publish through `createObject` + `enqueueDeliveries` + streaming (public/home) and link pending media (`pending_media:` KV, TTL extended at schedule time). Don't hand-roll inserts there.
- **SSRF**: run `safeFetch` (or at least `validateOutboundUrl`) before every outbound request. `safeFetch` re-validates each redirect hop and bounds the whole exchange with a timeout; it blocks private/metadata/CGNAT/multicast ranges and internal suffixes (DNS rebinding is out of scope inside a Worker).

## Code conventions

- **Path alias** `@/*` → repo root. Always import with `@/`.
- **API routes**: exported async `GET`/`POST`/… typed `(request: NextRequest, { params }: { params: Promise<{ id: string }> })`. Use `json()`/`notFound()`/`unauthorized()`/`badRequest()` from `@/lib/cf`.
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
