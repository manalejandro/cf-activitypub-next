<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Completed
- **Streaming fix** (`lib/streaming/timeline-do.ts`): DO now stores `initialChannel` on socket attachment and falls back to it for authenticated stream types (`user`, `user:notification`, `direct`) when clients subscribe dynamically — resolves Elk's "Unknown stream type" error
- **GET /api/v1/notifications/:id** (`app/api/v1/notifications/[id]/route.ts`): Get single notification with full serialization
- **POST /api/v1/notifications/:id/dismiss** (`app/api/v1/notifications/[id]/dismiss/route.ts`): Dismiss a single notification
- **GET /api/v2/notifications/policy** (`app/api/v2/notifications/policy/route.ts`): Get notification filtering policy (returns default accept-all)
- **PATCH /api/v2/notifications/policy** (`app/api/v2/notifications/policy/route.ts`): Update notification filtering policy
- **DB functions** (`lib/db/index.ts`): Added `getNotificationById()`, `dismissNotification()`
