# CF ActivityPub

> A Mastodon-compatible ActivityPub server built for the edge — powered by Cloudflare Workers, D1, and the open web.

## Overview

**CF ActivityPub** is a fully functional social server implementing the [ActivityPub](https://www.w3.org/TR/activitypub/) protocol with [Mastodon REST API](https://docs.joinmastodon.org/api/) compatibility. It runs entirely on [Cloudflare Workers](https://workers.cloudflare.com/) — no traditional servers, no Docker.

- **Zero cold starts** — Cloudflare's V8 isolate model starts instantly in 300+ edge locations
- **Mastodon client compatible** — works with Ivory, Elk, Tusky, Megalodon, and any Mastodon app
- **Federated** — follows, boosts, likes and mentions across the fediverse
- **Cryptographically secure** — HTTP Signatures via Web Crypto API
- **Fully open source** — MIT licensed

## Architecture

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers |
| Framework | Next.js 16 App Router via @opennextjs/cloudflare |
| Database | Cloudflare D1 (SQLite) |
| Cache / Sessions | Cloudflare KV |
| Media storage | Cloudflare R2 |
| Async delivery | Cloudflare Queues |
| Realtime streaming | Cloudflare Durable Objects |
| Crypto | Web Crypto API (RSASSA-PKCS1-v1_5 + PBKDF2) |
| Styling | Tailwind CSS v4 |

## Deploy

### Prerequisites

- Node.js 18+, npm
- A [Cloudflare](https://dash.cloudflare.com) account
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

### 1. Clone and install

```bash
git clone https://github.com/manalejandro/cf-activitypub-next.git
cd cf-activitypub-next
npm install
```

### 2. Create Cloudflare resources

```bash
wrangler login
wrangler d1 create cf-activitypub
wrangler kv namespace create CF_ACTIVITYPUB_KV
wrangler r2 bucket create cf-activitypub-media
wrangler queues create cf-activitypub-delivery
```

Copy the generated IDs into `wrangler.toml`:
- `database_id` under `[[d1_databases]]`
- `id` under `[[kv_namespaces]]`

### 3. Configure your domain

Edit `wrangler.toml` and set:
- `INSTANCE_URL` — your public domain (e.g. `https://social.example.com`)
- `pattern` under `[[routes]]` — your custom domain

### 4. Run database migrations

```bash
npm run db:migrate
```

This runs `lib/db/schema.sql` against your remote D1 database (all tables + indexes included).

To reset the database:

```bash
wrangler d1 execute cf-activitypub --remote --file=lib/db/drop.sql
npm run db:migrate
```

### 5. Deploy

```bash
npm run deploy
```

### Preview locally

```bash
npm run preview
```

Runs the Cloudflare Workers runtime locally via `wrangler dev` (uses remote D1 by default — see `wrangler.toml`).

## Features

### ActivityPub Federation
- WebFinger actor discovery
- Actor profiles, Inbox/Outbox, Followers/Following collections
- Shared inbox for efficient fan-out
- HTTP Signatures on all federated requests
- Handles: Create, Follow, Accept, Reject, Undo, Like, Announce, Delete, Update
- NodeInfo support

### Mastodon API
- OAuth 2.0 (password + client_credentials)
- Account registration, profile management, follow/unfollow
- Status create/delete, favourite, reblog, polls
- Home and public timelines, hashtag timelines
- Notifications (follow, mention, favourite, reblog)
- Media uploads (R2-backed)
- Blocks, domain blocks, follow requests

### Realtime
- Streaming timelines via Durable Objects

## License

MIT
