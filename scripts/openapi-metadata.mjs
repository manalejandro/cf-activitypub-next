// Curated metadata for the generated OpenAPI document.
// Kept separate from the generator so descriptions/tags/schemas are easy to maintain.
// The generator scans app/**/route.ts and merges this metadata on top.

export const TAGS = [
  { name: "Accounts", description: "User profiles, follow/unfollow, mute/block, relationships and verification." },
  { name: "Statuses", description: "Posts, boosts, favourites, bookmarks, pins, context and interaction policies." },
  { name: "Timelines", description: "Home, public and tag timelines with standard Mastodon pagination." },
  { name: "Notifications", description: "Notifications for follows, mentions, boosts, likes, polls and edits." },
  { name: "Instance", description: "Public instance metadata, peers, rules, languages and configuration." },
  { name: "Admin", description: "Account management, domain blocks, reports and the moderation log. Requires the admin role." },
  { name: "Filters", description: "Content filters (v1 and v2) with keyword and status rules." },
  { name: "Lists", description: "Curated lists of accounts and their timelines." },
  { name: "Conversations", description: "Direct message conversations with read/unread state." },
  { name: "Polls", description: "Poll metadata and voting." },
  { name: "Media", description: "Media attachment upload and management." },
  { name: "Search", description: "Account, hashtag and status search." },
  { name: "Trends", description: "Trending statuses, tags, links and the explore feed." },
  { name: "Follow Requests", description: "Approve or reject pending follow requests." },
  { name: "Favourites", description: "Favourited (liked) statuses." },
  { name: "Bookmarks", description: "Bookmarked statuses." },
  { name: "Endorsements", description: "Featured accounts (endorsements)." },
  { name: "Mutes", description: "Muted accounts." },
  { name: "Blocks", description: "Blocked accounts and domain blocks." },
  { name: "Featured Tags", description: "Tags a user has featured on their profile." },
  { name: "Followed Tags", description: "Hashtag subscriptions." },
  { name: "Suggestions", description: "Account suggestions and dismissal." },
  { name: "Directory", description: "Public account directory." },
  { name: "Announcements", description: "Instance announcements." },
  { name: "Reports", description: "Report statuses/accounts to the moderators." },
  { name: "Scheduled Statuses", description: "Posts scheduled for future publication." },
  { name: "Push", description: "Web push subscriptions." },
  { name: "Preferences", description: "User preferences." },
  { name: "Markers", description: "Timeline read markers." },
  { name: "Streaming", description: "WebSocket streaming endpoint health and events." },
  { name: "Calls", description: "WebRTC audio/video calls between accounts." },
  { name: "E2EE", description: "End-to-end encrypted messaging (MLS)." },
  { name: "Import/Export", description: "Import and export of the following list." },
  { name: "Apps", description: "OAuth application registration and verification." },
  { name: "Emails", description: "Email verification and password recovery." },
  { name: "OAuth", description: "OAuth 2.0 token endpoints (password and client credentials grants)." },
  { name: "Auth", description: "Session authentication helpers." },
  { name: "ActivityPub", description: "Federation endpoints (actors, inbox, outbox, objects, nodeinfo, WebFinger)." },
  { name: "Tags", description: "Hashtag search, follow/unfollow and featuring." },
  { name: "Collections", description: "Federated featured collections (FEP-7aa9)." },
  { name: "Maps", description: "OpenStreetMap tile proxy used by geolocated posts." },
];

// Endpoints that do NOT require an access token.
// PUBLIC_ALL: prefixes where every operation is public.
// PUBLIC_GET: exact paths where only GET is public (write operations stay protected).
// PUBLIC_POST: exact paths where only POST is public.
export const PUBLIC = {
  all: [
    "/.well-known",
    "/nodeinfo",
    "/objects",
    "/inbox",
    "/users",
    "/api/v1/instance",
    "/api/v1/custom_emojis",
    "/api/v1/trends",
    "/api/v1/directory",
    "/api/v1/streaming",
    // ActivityPub surface served through /api/* route handlers (middleware
    // rewrites the public /users, /inbox, /nodeinfo paths onto them).
    "/api/users",
    "/api/inbox",
    "/api/nodeinfo",
    "/api/media",
    "/api/map",
    "/api/v1/collections",
    "/api/v1/tags",
    "/authorize_interaction",
    "/manifest.webmanifest",
    "/security.txt",
  ],
  GET: [
    "/api/v1/statuses/{id}",
    "/api/v1/statuses/{id}/context",
    "/api/v1/statuses/{id}/quotes",
    "/api/v1/statuses/{id}/interaction_policy",
    "/api/v1/statuses/{id}/favourited_by",
    "/api/v1/statuses/{id}/reblogged_by",
    "/api/v1/statuses/{id}/history",
    "/api/v1/polls/{id}",
    "/api/v1/media/{id}",
    "/api/v1/tags/{name}",
    "/api/v1/timelines/public",
    "/api/v1/timelines/tag/{hashtag}",
    "/api/v1/accounts/lookup",
    "/api/v1/accounts/search",
    "/api/v1/featured_tags/suggestions",
    "/api/auth/status",
    "/api/auth/verify-email",
    // oEmbed provider: external sites/crawlers resolve status embeds without a token.
    "/api/oembed",
  ],
  POST: [
    "/oauth/token",
    "/oauth/revoke",
    "/api/v1/apps",
    "/api/auth/forgot-password",
    "/api/auth/reset-password",
    "/api/auth/resend-verification",
    "/api/auth/logout",
  ],
};

// Paths documented manually (no route.ts handler in app/).
export const MANUAL_PATHS = {
  "/api/v1/streaming": {
    GET: {
      summary: "Streaming WebSocket endpoint",
      description: "Real-time WebSocket stream for timelines and notifications. Open a WebSocket to `/api/v1/streaming?stream=...&access_token=...` and listen for `update`, `notification`, `delete`, `status.update` and `conversation` events.",
      operationId: "streamingWs",
      tags: ["Streaming"],
      security: [],
      responses: { 101: { description: "WebSocket upgrade" } },
    },
  },
};

// Path prefix → default tag
export const PATH_TAGS = [
  ["/api/v1/accounts", "Accounts"],
  ["/api/v1/statuses", "Statuses"],
  ["/api/v1/timelines", "Timelines"],
  ["/api/v1/notifications", "Notifications"],
  ["/api/v1/instance", "Instance"],
  ["/api/v2/instance", "Instance"],
  ["/api/v1/admin", "Admin"],
  ["/api/v2/admin", "Admin"],
  ["/api/v1/filters", "Filters"],
  ["/api/v2/filters", "Filters"],
  ["/api/v1/lists", "Lists"],
  ["/api/v1/conversations", "Conversations"],
  ["/api/v1/polls", "Polls"],
  ["/api/v1/media", "Media"],
  ["/api/v2/media", "Media"],
  ["/api/v1/search", "Search"],
  ["/api/v2/search", "Search"],
  ["/api/v1/trends", "Trends"],
  ["/api/v1/follow_requests", "Follow Requests"],
  ["/api/v1/favourites", "Favourites"],
  ["/api/v1/bookmarks", "Bookmarks"],
  ["/api/v1/endorsements", "Endorsements"],
  ["/api/v1/mutes", "Mutes"],
  ["/api/v1/blocks", "Blocks"],
  ["/api/v1/domain_blocks", "Blocks"],
  ["/api/v1/featured_tags", "Featured Tags"],
  ["/api/v1/tags", "Tags"],
  ["/api/v1/collections", "Collections"],
  ["/api/v1/graph", "Instance"],
  ["/api/v1/custom_emojis", "Instance"],
  ["/api/v2/notifications", "Notifications"],
  ["/api/admin", "Admin"],
  ["/api/media", "Media"],
  ["/api/map", "Maps"],
  ["/api/oembed", "Statuses"],
  ["/api/oauth", "OAuth"],
  ["/api/users", "ActivityPub"],
  ["/api/inbox", "ActivityPub"],
  ["/api/nodeinfo", "ActivityPub"],
  ["/authorize_interaction", "Apps"],
  ["/manifest.webmanifest", "Instance"],
  ["/security.txt", "Instance"],
  ["/api/v1/followed_tags", "Followed Tags"],
  ["/api/v1/suggestions", "Suggestions"],
  ["/api/v2/suggestions", "Suggestions"],
  ["/api/v1/directory", "Directory"],
  ["/api/v1/announcements", "Announcements"],
  ["/api/v1/reports", "Reports"],
  ["/api/v1/scheduled_statuses", "Scheduled Statuses"],
  ["/api/v1/push", "Push"],
  ["/api/v1/preferences", "Preferences"],
  ["/api/v1/markers", "Markers"],
  ["/api/v1/streaming", "Streaming"],
  ["/api/v1/calls", "Calls"],
  ["/api/v1/e2ee", "E2EE"],
  ["/api/v1/export", "Import/Export"],
  ["/api/v1/import", "Import/Export"],
  ["/api/v1/apps", "Apps"],
  ["/api/v1/emails", "Emails"],
  ["/api/v1/profile", "Accounts"],
  ["/api/v1/accounts/migrate", "Accounts"],
  ["/oauth", "OAuth"],
  ["/api/auth", "Auth"],
  ["/nodeinfo", "ActivityPub"],
  ["/inbox", "ActivityPub"],
  ["/users", "ActivityPub"],
  ["/objects", "ActivityPub"],
  ["/.well-known", "ActivityPub"],
];

// Curated operation metadata: path → { method → { summary, description, operationId, security, requestBody, responses } }
export const OP_META = {
  "/oauth/token": {
    POST: {
      summary: "Obtain an OAuth access token",
      description: "Mastodon-compatible OAuth 2.0 token endpoint. Supports the `password` grant with an account email/username and password. Rate-limited to 10 attempts per IP per minute.",
      operationId: "createToken",
      tags: ["OAuth"],
      security: [],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                grant_type: { type: "string", enum: ["password", "client_credentials"], description: "OAuth grant type. `password` is required for user tokens." },
                username: { type: "string", description: "Account email address or username." },
                password: { type: "string", description: "Account password." },
                client_id: { type: "string", description: "OAuth client id (from a registered app)." },
                client_secret: { type: "string", description: "OAuth client secret." },
                scope: { type: "string", description: "Requested scopes, space separated." },
                "cf-turnstile-response": { type: "string", description: "Optional Cloudflare Turnstile token for web-form logins." },
              },
            },
          },
        },
      },
    },
  },
  "/oauth/revoke": {
    POST: {
      summary: "Revoke an access token",
      operationId: "revokeToken",
      tags: ["OAuth"],
      security: [],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object", properties: { client_id: { type: "string" }, client_secret: { type: "string" }, token: { type: "string", description: "Access token to revoke." } }, required: ["token"] } } },
      },
    },
  },
  "/api/v1/accounts/verify_credentials": {
    GET: {
      summary: "Verify account credentials",
      description: "Returns the authenticated user's account (with additional fields such as role and source).",
      operationId: "verifyCredentials",
      tags: ["Accounts"],
    },
    PATCH: {
      summary: "Update account credentials",
      description: "Update the authenticated user's display name, bio, avatar, header or profile metadata.",
      operationId: "updateCredentials",
      tags: ["Accounts"],
    },
  },
  "/api/v1/accounts/update_credentials": {
    PATCH: {
      summary: "Update account credentials (v1)",
      description: "Alias of PATCH /api/v1/accounts/update_credentials.",
      operationId: "updateCredentialsV1",
      tags: ["Accounts"],
    },
  },
  "/api/v1/accounts/{id}": {
    GET: {
      summary: "View account by ID",
      operationId: "getAccount",
      tags: ["Accounts"],
    },
  },
  "/api/v1/accounts/{id}/statuses": {
    GET: {
      summary: "View an account's statuses",
      description: "Paginated list of the account's posts. Supports `exclude_reblogs`, `tagged`, `only_media`, `pinned`, `only_replies` and standard Mastodon pagination.",
      operationId: "getAccountStatuses",
      tags: ["Accounts"],
    },
  },
  "/api/v1/accounts/{id}/followers": {
    GET: { summary: "View an account's followers", operationId: "getAccountFollowers", tags: ["Accounts"] },
  },
  "/api/v1/accounts/{id}/following": {
    GET: { summary: "View an account's following", operationId: "getAccountFollowing", tags: ["Accounts"] },
  },
  "/api/v1/accounts/{id}/follow": {
    POST: { summary: "Follow an account", operationId: "followAccount", tags: ["Accounts"] },
  },
  "/api/v1/accounts/{id}/unfollow": {
    POST: { summary: "Unfollow an account", operationId: "unfollowAccount", tags: ["Accounts"] },
  },
  "/api/v1/accounts/{id}/mute": {
    POST: { summary: "Mute an account", operationId: "muteAccount", tags: ["Accounts"] },
  },
  "/api/v1/accounts/{id}/unmute": {
    POST: { summary: "Unmute an account", operationId: "unmuteAccount", tags: ["Accounts"] },
  },
  "/api/v1/accounts/{id}/block": {
    POST: { summary: "Block an account", operationId: "blockAccount", tags: ["Accounts"] },
  },
  "/api/v1/accounts/{id}/unblock": {
    POST: { summary: "Unblock an account", operationId: "unblockAccount", tags: ["Accounts"] },
  },
  "/api/v1/accounts/{id}/pin": {
    POST: { summary: "Feature an account (endorse)", operationId: "endorseAccount", tags: ["Accounts"] },
  },
  "/api/v1/accounts/{id}/unpin": {
    POST: { summary: "Unfeature an account", operationId: "unendorseAccount", tags: ["Accounts"] },
  },
  "/api/v1/accounts/{id}/note": {
    POST: { summary: "Set a private note on an account", operationId: "setAccountNote", tags: ["Accounts"] },
  },
  "/api/v1/accounts/relationships": {
    GET: { summary: "View relationships between accounts", operationId: "getRelationships", tags: ["Accounts"] },
  },
  "/api/v1/accounts/lookup": {
    GET: { summary: "Look up an account by username", description: "Looks up a local or remote account. Remote accounts are resolved via WebFinger when `resolve=true`.", operationId: "lookupAccount", tags: ["Accounts"], security: [] },
  },
  "/api/v1/accounts/search": {
    GET: { summary: "Search accounts", operationId: "searchAccounts", tags: ["Accounts"], security: [] },
  },
  "/api/v1/accounts/migrate": {
    POST: { summary: "Migrate the account to another instance", operationId: "migrateAccount", tags: ["Accounts"] },
  },
  "/api/v1/accounts/delete": {
    POST: { summary: "Delete the account", description: "Permanently deletes the local account and federates a Delete tombstone.", operationId: "deleteAccount", tags: ["Accounts"] },
  },
  "/api/v1/statuses": {
    POST: {
      summary: "Publish a new status",
      description: "Create a new post, optionally with media attachments, a poll, content warning, or as a reply. Supports the `Idempotency-Key` header to prevent duplicates. Posts with media attachments are also accepted as `multipart/form-data`.",
      operationId: "createStatus",
      tags: ["Statuses"],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                status: { type: "string", description: "Text content of the status." },
                in_reply_to_id: { type: "string", description: "ID of the status being replied to." },
                media_ids: { type: "array", items: { type: "string" }, description: "IDs of media attachments to attach." },
                sensitive: { type: "boolean", description: "Mark media as sensitive (NSFW)." },
                spoiler_text: { type: "string", description: "Content warning / subject line." },
                visibility: { type: "string", enum: ["public", "unlisted", "private", "direct"], default: "public" },
                language: { type: "string", description: "ISO 639-1 language code." },
                scheduled_at: { type: "string", description: "ISO 8601 datetime to schedule the post for." },
                poll: {
                  type: "object",
                  properties: {
                    options: { type: "array", items: { type: "string" }, description: "Poll options (at least 2)." },
                    expires_in: { type: "integer", description: "Poll lifetime in seconds (min 300)." },
                    multiple: { type: "boolean", description: "Allow multiple choices." },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  "/api/v1/statuses/{id}": {
    GET: { summary: "View a status", operationId: "getStatus", tags: ["Statuses"], security: [] },
    DELETE: { summary: "Delete a status", operationId: "deleteStatus", tags: ["Statuses"] },
  },
  "/api/v1/statuses/{id}/context": {
    GET: { summary: "View the thread context of a status", operationId: "getStatusContext", tags: ["Statuses"], security: [] },
  },
  "/api/v1/statuses/{id}/reblog": {
    POST: { summary: "Boost a status", operationId: "reblogStatus", tags: ["Statuses"] },
  },
  "/api/v1/statuses/{id}/unreblog": {
    POST: { summary: "Undo a boost", operationId: "unreblogStatus", tags: ["Statuses"] },
  },
  "/api/v1/statuses/{id}/favourite": {
    POST: { summary: "Favourite a status", operationId: "favouriteStatus", tags: ["Statuses"] },
  },
  "/api/v1/statuses/{id}/unfavourite": {
    POST: { summary: "Unfavourite a status", operationId: "unfavouriteStatus", tags: ["Statuses"] },
  },
  "/api/v1/statuses/{id}/bookmark": {
    POST: { summary: "Bookmark a status", operationId: "bookmarkStatus", tags: ["Statuses"] },
  },
  "/api/v1/statuses/{id}/unbookmark": {
    POST: { summary: "Remove a bookmark", operationId: "unbookmarkStatus", tags: ["Statuses"] },
  },
  "/api/v1/statuses/{id}/pin": {
    POST: { summary: "Pin a status to the profile", operationId: "pinStatus", tags: ["Statuses"] },
  },
  "/api/v1/statuses/{id}/unpin": {
    POST: { summary: "Unpin a status", operationId: "unpinStatus", tags: ["Statuses"] },
  },
  "/api/v1/statuses/{id}/mute": {
    POST: { summary: "Mute a conversation", operationId: "muteConversation", tags: ["Statuses"] },
  },
  "/api/v1/statuses/{id}/unmute": {
    POST: { summary: "Unmute a conversation", operationId: "unmuteConversation", tags: ["Statuses"] },
  },
  "/api/v1/statuses/{id}/source": {
    GET: { summary: "View the source text of a status", operationId: "getStatusSource", tags: ["Statuses"] },
  },
  "/api/v1/statuses/{id}/history": {
    GET: { summary: "View the edit history of a status", operationId: "getStatusHistory", tags: ["Statuses"] },
  },
  "/api/v1/statuses/{id}/favourited_by": {
    GET: { summary: "View accounts that favourited a status", operationId: "getStatusFavouritedBy", tags: ["Statuses"] },
  },
  "/api/v1/statuses/{id}/reblogged_by": {
    GET: { summary: "View accounts that boosted a status", operationId: "getStatusRebloggedBy", tags: ["Statuses"] },
  },
  "/api/v1/statuses/{id}/translate": {
    POST: { summary: "Translate a status", operationId: "translateStatus", tags: ["Statuses"] },
  },
  "/api/v1/timelines/home": {
    GET: { summary: "View the home timeline", description: "Statuses from accounts the user follows.", operationId: "getHomeTimeline", tags: ["Timelines"] },
  },
  "/api/v1/timelines/public": {
    GET: { summary: "View the public timeline", operationId: "getPublicTimeline", tags: ["Timelines"], security: [] },
  },
  "/api/v1/timelines/tag/{hashtag}": {
    GET: { summary: "View statuses for a hashtag", operationId: "getHashtagTimeline", tags: ["Timelines"], security: [] },
  },
  "/api/v1/timelines/list": {
    GET: { summary: "View a list timeline", operationId: "getListTimeline", tags: ["Timelines"] },
  },
  "/api/v1/notifications": {
    GET: { summary: "View notifications", operationId: "getNotifications", tags: ["Notifications"] },
  },
  "/api/v1/notifications/{id}": {
    GET: { summary: "View a single notification", operationId: "getNotification", tags: ["Notifications"] },
    POST: { summary: "Dismiss a notification", operationId: "dismissNotification", tags: ["Notifications"] },
  },
  "/api/v1/notifications/unread_count": {
    GET: { summary: "Count unread notifications", operationId: "getUnreadNotificationsCount", tags: ["Notifications"] },
  },
  "/api/v1/notifications/clear": {
    POST: { summary: "Clear all notifications", operationId: "clearNotifications", tags: ["Notifications"] },
  },
  "/api/v1/instance": {
    GET: { summary: "View instance information (v1)", operationId: "getInstanceV1", tags: ["Instance"], security: [] },
  },
  "/api/v2/instance": {
    GET: { summary: "View instance information (v2)", operationId: "getInstanceV2", tags: ["Instance"], security: [] },
  },
  "/api/v1/instance/peers": {
    GET: { summary: "List federated instance domains", operationId: "getInstancePeers", tags: ["Instance"], security: [] },
  },
  "/api/v1/instance/activity": {
    GET: { summary: "Weekly instance activity", operationId: "getInstanceActivity", tags: ["Instance"], security: [] },
  },
  "/api/v1/instance/rules": {
    GET: { summary: "View instance rules", operationId: "getInstanceRules", tags: ["Instance"], security: [] },
  },
  "/api/v1/instance/languages": {
    GET: { summary: "View instance languages", operationId: "getInstanceLanguages", tags: ["Instance"], security: [] },
  },
  "/api/v1/instance/domain_blocks": {
    GET: { summary: "View instance domain blocks", operationId: "getInstanceDomainBlocks", tags: ["Instance"], security: [] },
  },
  "/api/v1/instance/privacy_policy": {
    GET: { summary: "View the privacy policy", operationId: "getInstancePrivacyPolicy", tags: ["Instance"], security: [] },
  },
  "/api/v1/instance/terms_of_service": {
    GET: { summary: "View the terms of service", operationId: "getInstanceTermsOfService", tags: ["Instance"], security: [] },
  },
  "/api/v1/instance/extended_description": {
    GET: { summary: "View the extended description", operationId: "getInstanceExtendedDescription", tags: ["Instance"], security: [] },
  },
  "/api/v1/instance/translation_languages": {
    GET: { summary: "View supported translation languages", operationId: "getInstanceTranslationLanguages", tags: ["Instance"], security: [] },
  },
  "/api/v1/custom_emojis": {
    GET: { summary: "View custom emojis", operationId: "getCustomEmojis", tags: ["Instance"], security: [] },
  },
  "/api/v1/streaming/health": {
    GET: { summary: "Streaming health check", description: "Mastodon clients call this before opening the streaming WebSocket.", operationId: "streamingHealth", tags: ["Streaming"], security: [] },
  },
  "/api/v1/streaming": {
    GET: { summary: "Streaming WebSocket endpoint", description: "WebSocket connection for real-time timeline and notification events.", operationId: "streamingWs", tags: ["Streaming"], security: [] },
  },
  "/api/v1/statuses/{id}/interaction_policy": {
    GET: { summary: "View a status' interaction policy", operationId: "getInteractionPolicy", tags: ["Statuses"], security: [] },
  },
  "/api/v1/statuses/{id}/quotes": {
    GET: { summary: "View statuses that quote this one", operationId: "getStatusQuotes", tags: ["Statuses"], security: [] },
  },
};

// Component schemas describing the wire format of the Mastodon-compatible API.
export const SCHEMAS = {
  Account: {
    type: "object",
    description: "A user profile.",
    properties: {
      id: { type: "string", description: "Local unique ID." },
      username: { type: "string" },
      acct: { type: "string", description: "Username and domain, e.g. `alice` or `alice@remote.example`." },
      display_name: { type: "string" },
      locked: { type: "boolean" },
      bot: { type: "boolean" },
      discoverable: { type: "boolean" },
      group: { type: "boolean" },
      created_at: { type: "string", format: "date-time" },
      note: { type: "string", description: "Bio, as sanitized HTML." },
      url: { type: "string", format: "uri" },
      avatar: { type: "string", format: "uri" },
      avatar_static: { type: "string", format: "uri" },
      header: { type: "string", format: "uri" },
      header_static: { type: "string", format: "uri" },
      followers_count: { type: "integer", format: "int64" },
      following_count: { type: "integer", format: "int64" },
      statuses_count: { type: "integer", format: "int64" },
      last_status_at: { type: "string", format: "date" },
      fields: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            value: { type: "string", description: "Sanitized HTML." },
            verified_at: { type: "string", nullable: true, description: "ISO 8601 datetime when the field was verified, if ever." },
          },
        },
      },
      emojis: { type: "array", items: { $ref: "#/components/schemas/Emoji" } },
      roles: { type: "array", items: { type: "object", properties: { name: { type: "string" }, color: { type: "string" } } } },
    },
  },
  CredentialAccount: {
    allOf: [
      { $ref: "#/components/schemas/Account" },
      {
        type: "object",
        properties: {
          source: {
            type: "object",
            properties: {
              privacy: { type: "string", enum: ["public", "unlisted", "private", "direct"] },
              sensitive: { type: "boolean" },
              language: { type: "string" },
              note: { type: "string" },
              fields: { type: "array", items: { type: "object", properties: { name: { type: "string" }, value: { type: "string" } } } },
            },
          },
          role: { type: "string", enum: ["admin", "moderator", "user"] },
          is_following: { type: "boolean" },
          is_followed_by: { type: "boolean" },
        },
      },
    ],
  },
  Relationship: {
    type: "object",
    properties: {
      id: { type: "string" },
      following: { type: "boolean" },
      showing_reblogs: { type: "boolean" },
      notifying: { type: "boolean" },
      followed_by: { type: "boolean" },
      blocking: { type: "boolean" },
      blocked_by: { type: "boolean" },
      muting: { type: "boolean" },
      muting_notifications: { type: "boolean" },
      requested: { type: "boolean" },
      domain_blocking: { type: "boolean" },
      endorsed: { type: "boolean" },
      note: { type: "string" },
    },
  },
  Status: {
    type: "object",
    description: "A post (status).",
    properties: {
      id: { type: "string" },
      uri: { type: "string", format: "uri" },
      url: { type: "string", format: "uri", nullable: true },
      account: { $ref: "#/components/schemas/Account" },
      in_reply_to_id: { type: "string", nullable: true },
      in_reply_to_account_id: { type: "string", nullable: true },
      reblog: { $ref: "#/components/schemas/Status", nullable: true },
      content: { type: "string", description: "Sanitized HTML content." },
      plain_content: { type: "string", description: "Plain-text version of the content." },
      created_at: { type: "string", format: "date-time" },
      edited_at: { type: "string", format: "date-time", nullable: true },
      emojis: { type: "array", items: { $ref: "#/components/schemas/Emoji" } },
      replies_count: { type: "integer", format: "int64" },
      reblogs_count: { type: "integer", format: "int64" },
      favourites_count: { type: "integer", format: "int64" },
      reblogged: { type: "boolean", nullable: true },
      favourited: { type: "boolean", nullable: true },
      bookmarked: { type: "boolean", nullable: true },
      muted: { type: "boolean", nullable: true },
      pinned: { type: "boolean", nullable: true },
      sensitive: { type: "boolean" },
      spoiler_text: { type: "string" },
      visibility: { type: "string", enum: ["public", "unlisted", "private", "direct"] },
      media_attachments: { type: "array", items: { $ref: "#/components/schemas/MediaAttachment" } },
      mentions: { type: "array", items: { $ref: "#/components/schemas/Mention" } },
      tags: { type: "array", items: { $ref: "#/components/schemas/Tag" } },
      poll: { $ref: "#/components/schemas/Poll", nullable: true },
      card: { type: "object", nullable: true },
      language: { type: "string", nullable: true },
      application: { type: "object", nullable: true },
      interaction_policy: { type: "object", nullable: true },
      quotes_count: { type: "integer", nullable: true },
    },
  },
  StatusSource: {
    type: "object",
    properties: {
      id: { type: "string" },
      text: { type: "string" },
      spoiler_text: { type: "string" },
      language: { type: "string", nullable: true },
    },
  },
  MediaAttachment: {
    type: "object",
    properties: {
      id: { type: "string" },
      type: { type: "string", enum: ["image", "video", "gifv", "audio", "unknown"] },
      url: { type: "string", format: "uri" },
      preview_url: { type: "string", format: "uri" },
      remote_url: { type: "string", format: "uri", nullable: true },
      text_url: { type: "string", nullable: true },
      meta: { type: "object", nullable: true },
      description: { type: "string", description: "Alt text." },
      blurhash: { type: "string", nullable: true },
    },
  },
  Emoji: {
    type: "object",
    properties: {
      shortcode: { type: "string" },
      url: { type: "string", format: "uri" },
      static_url: { type: "string", format: "uri" },
      visible_in_picker: { type: "boolean" },
      category: { type: "string" },
    },
  },
  Mention: {
    type: "object",
    properties: {
      id: { type: "string" },
      username: { type: "string" },
      url: { type: "string", format: "uri" },
      acct: { type: "string" },
    },
  },
  Tag: {
    type: "object",
    properties: {
      name: { type: "string" },
      url: { type: "string", format: "uri" },
      history: {
        type: "array",
        items: { type: "object", properties: { day: { type: "string" }, uses: { type: "string" }, accounts: { type: "string" } } },
      },
      following: { type: "boolean", description: "Whether the authenticated user follows this tag." },
    },
  },
  Poll: {
    type: "object",
    properties: {
      id: { type: "string" },
      expires_at: { type: "string", format: "date-time", nullable: true },
      expired: { type: "boolean" },
      multiple: { type: "boolean" },
      votes_count: { type: "integer", format: "int64" },
      voters_count: { type: "integer", format: "int64" },
      voted: { type: "boolean", nullable: true },
      own_votes: { type: "array", items: { type: "integer" }, nullable: true },
      options: {
        type: "array",
        items: { type: "object", properties: { title: { type: "string" }, votes_count: { type: "integer", format: "int64" } } },
      },
      emojis: { type: "array", items: { $ref: "#/components/schemas/Emoji" } },
    },
  },
  Notification: {
    type: "object",
    properties: {
      id: { type: "string" },
      type: {
        type: "string",
        enum: ["follow", "follow_request", "mention", "reblog", "favourite", "poll", "update", "admin.sign_up", "admin.report"],
      },
      created_at: { type: "string", format: "date-time" },
      account: { $ref: "#/components/schemas/Account" },
      status: { $ref: "#/components/schemas/Status", nullable: true },
      report: { type: "object", nullable: true },
      group_key: { type: "string", nullable: true },
    },
  },
  List: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      replies_policy: { type: "string", enum: ["followed", "list", "none"] },
    },
  },
  Conversation: {
    type: "object",
    properties: {
      id: { type: "string" },
      unread: { type: "boolean" },
      accounts: { type: "array", items: { $ref: "#/components/schemas/Account" } },
      last_status: { $ref: "#/components/schemas/Status", nullable: true },
    },
  },
  FilterKeyword: {
    type: "object",
    properties: {
      id: { type: "string" },
      keyword: { type: "string" },
      whole_word: { type: "boolean" },
    },
  },
  FilterStatus: {
    type: "object",
    properties: {
      id: { type: "string" },
      status_id: { type: "string" },
    },
  },
  FilterV1: {
    type: "object",
    properties: {
      id: { type: "string" },
      phrase: { type: "string" },
      context: { type: "array", items: { type: "string", enum: ["home", "notifications", "public", "thread", "account"] } },
      expires_at: { type: "string", format: "date-time", nullable: true },
      irreversible: { type: "boolean" },
      whole_word: { type: "boolean" },
    },
  },
  FilterV2: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      context: { type: "array", items: { type: "string", enum: ["home", "notifications", "public", "thread", "account"] } },
      expires_at: { type: "string", format: "date-time", nullable: true },
      filter_action: { type: "string", enum: ["warn", "hide"] },
      keywords: { type: "array", items: { $ref: "#/components/schemas/FilterKeyword" } },
      statuses: { type: "array", items: { $ref: "#/components/schemas/FilterStatus" } },
    },
  },
  Announcement: {
    type: "object",
    properties: {
      id: { type: "string" },
      content: { type: "string" },
      starts_at: { type: "string", format: "date-time", nullable: true },
      ends_at: { type: "string", format: "date-time", nullable: true },
      published: { type: "boolean" },
      all_day: { type: "boolean" },
      published_at: { type: "string", format: "date-time", nullable: true },
      updated_at: { type: "string", format: "date-time", nullable: true },
      read: { type: "boolean", nullable: true },
      reactions: { type: "array", items: { type: "object" } },
      statuses: { type: "array", items: { $ref: "#/components/schemas/Status" } },
    },
  },
  ScheduledStatus: {
    type: "object",
    properties: {
      id: { type: "string" },
      scheduled_at: { type: "string", format: "date-time" },
      params: { type: "object" },
      media_attachments: { type: "array", items: { $ref: "#/components/schemas/MediaAttachment" } },
    },
  },
  Marker: {
    type: "object",
    properties: {
      id: { type: "string" },
      last_read_id: { type: "string" },
      updated_at: { type: "string", format: "date-time" },
      version: { type: "integer" },
    },
  },
  PushSubscription: {
    type: "object",
    properties: {
      id: { type: "string" },
      endpoint: { type: "string", format: "uri" },
      server_key: { type: "string" },
      alerts: { type: "object" },
      policy: { type: "string" },
    },
  },
  InstanceV2: {
    type: "object",
    properties: {
      domain: { type: "string" },
      title: { type: "string" },
      version: { type: "string" },
      source_url: { type: "string", nullable: true },
      description: { type: "string" },
      usage: { type: "object", properties: { users: { type: "object", properties: { active_month: { type: "integer" } } } } },
      thumbnail: { type: "object", nullable: true, properties: { url: { type: "string" }, blurhash: { type: "string" } } },
      languages: { type: "array", items: { type: "string" } },
      configuration: { type: "object" },
      registrations: { type: "object" },
      contact: { type: "object", nullable: true },
      rules: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } } } },
    },
  },
  Report: {
    type: "object",
    properties: {
      id: { type: "string" },
      action_taken: { type: "boolean" },
      action_taken_at: { type: "string", format: "date-time", nullable: true },
      category: { type: "string" },
      comment: { type: "string" },
      forwarded: { type: "boolean" },
      status_ids: { type: "array", items: { type: "string" } },
      rule_ids: { type: "array", items: { type: "string" } },
      target_account: { $ref: "#/components/schemas/Account" },
      created_at: { type: "string", format: "date-time" },
    },
  },
  AdminAccount: {
    type: "object",
    properties: {
      id: { type: "string" },
      username: { type: "string" },
      domain: { type: "string", nullable: true },
      created_at: { type: "string", format: "date-time" },
      email: { type: "string" },
      ip: { type: "string", nullable: true },
      ip_policy: { type: "string", nullable: true },
      locale: { type: "string" },
      invite_request: { type: "string", nullable: true },
      role: { type: "string", enum: ["admin", "moderator", "user"] },
      confirmed: { type: "boolean" },
      approved: { type: "boolean" },
      disabled: { type: "boolean" },
      silenced: { type: "boolean" },
      suspended: { type: "boolean" },
      account: { $ref: "#/components/schemas/Account" },
    },
  },
  DomainBlock: {
    type: "object",
    properties: {
      id: { type: "string" },
      domain: { type: "string" },
      created_at: { type: "string", format: "date-time" },
      severity: { type: "string", enum: ["suspend", "silence", "noop"] },
      reject_media: { type: "boolean" },
      reject_reports: { type: "boolean" },
      private_comment: { type: "string", nullable: true },
      public_comment: { type: "string", nullable: true },
      obfuscate: { type: "boolean" },
    },
  },
  ModerationLogEntry: {
    type: "object",
    properties: {
      id: { type: "string" },
      action: { type: "string" },
      actioned_at: { type: "string", format: "date-time" },
      account: { $ref: "#/components/schemas/Account" },
      target: { type: "object", nullable: true },
      created_at: { type: "string", format: "date-time" },
    },
  },
  FeaturedTag: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      statuses_count: { type: "integer", format: "int64" },
      last_status_at: { type: "string", format: "date-time", nullable: true },
    },
  },
  Suggestion: {
    type: "object",
    properties: {
      source: { type: "string" },
      account: { $ref: "#/components/schemas/Account" },
    },
  },
  Error: {
    type: "object",
    properties: {
      error: { type: "string", description: "Error message, or an object describing validation errors." },
      error_description: { type: "string" },
    },
  },
  Empty: { type: "object", description: "No content." },
  IdList: { type: "object", properties: { id: { type: "array", items: { type: "string" } } } },
};

// Common query parameter schemas, keyed by name.
export const QUERY_PARAMETERS = {
  limit: { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 40, default: 20 }, description: "Maximum number of results to return." },
  max_id: { name: "max_id", in: "query", schema: { type: "string" }, description: "Return results older than this ID (pagination)." },
  since_id: { name: "since_id", in: "query", schema: { type: "string" }, description: "Return results newer than this ID (pagination)." },
  min_id: { name: "min_id", in: "query", schema: { type: "string" }, description: "Return results immediately newer than this ID (pagination)." },
  offset: { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 }, description: "Skip the first N results." },
  page: { name: "page", in: "query", schema: { type: "integer", minimum: 1 }, description: "Page number." },
  q: { name: "q", in: "query", schema: { type: "string" }, description: "Search query." },
  local: { name: "local", in: "query", schema: { type: "boolean", default: false }, description: "Only return local results." },
  resolve: { name: "resolve", in: "query", schema: { type: "boolean", default: false }, description: "Resolve remote accounts via WebFinger." },
};
