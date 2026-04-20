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
| Crypto | Web Crypto API (RSASSA-PKCS1-v1_5 + PBKDF2) |
| Styling | Tailwind CSS v4 |

## Getting Started

### Prerequisites

- Node.js 18+, npm
- A [Cloudflare](https://dash.cloudflare.com) account
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

### Install

```bash
git clone https://github.com/manalejandro/cf-activitypub-next.git
cd cf-activitypub-next
npm install
```

### Create Cloudflare resources

```bash
wrangler login
wrangler d1 create cf-activitypub
wrangler kv namespace create CF_ACTIVITYPUB_KV
wrangler r2 bucket create cf-activitypub-media
wrangler queues create cf-activitypub-delivery
```

Copy the generated IDs into `wrangler.toml`.

### Database migrations

```bash
npm run db:migrate          # local
npm run db:migrate:remote   # production
```

### Run locally

```bash
npm run dev
```

### Deploy

```bash
npm run deploy
```

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
- Status create/delete, favourite, reblog
- Home and public timelines
- Notifications (follow, mention, favourite, reblog)

## License

MIT
