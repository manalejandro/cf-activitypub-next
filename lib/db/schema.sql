-- CF ActivityPub D1 Database Schema
-- Run with: wrangler d1 execute cf-activitypub --remote --file=lib/db/schema.sql
-- Includes all migrations (v1 + v2)

-- ─────────────────────────────────────────
-- Actors (local + cached remote)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS actors (
  id              TEXT PRIMARY KEY,           -- full AP IRI
  username        TEXT NOT NULL,
  domain          TEXT NOT NULL,
  display_name    TEXT,
  summary         TEXT,
  avatar_url      TEXT,
  header_url      TEXT,
  public_key_pem  TEXT NOT NULL,
  private_key_pem TEXT,                       -- only for local accounts
  is_local        INTEGER NOT NULL DEFAULT 0,
  is_bot          INTEGER NOT NULL DEFAULT 0,
  manually_approves_followers INTEGER NOT NULL DEFAULT 0,
  discoverable    INTEGER NOT NULL DEFAULT 1,
  followers_count INTEGER NOT NULL DEFAULT 0,
  following_count INTEGER NOT NULL DEFAULT 0,
  statuses_count  INTEGER NOT NULL DEFAULT 0,
  email           TEXT UNIQUE,               -- only for local accounts
  password_hash   TEXT,                      -- only for local accounts
  email_verified  INTEGER NOT NULL DEFAULT 0, -- 1 once the user clicks the verification link
  inbox              TEXT,                      -- AP inbox URL (null for local actors using /users/:u/inbox)
  auto_delete_after  INTEGER,                   -- auto-delete posts after N seconds (null = disabled)
  role               TEXT NOT NULL DEFAULT 'user', -- user, moderator, admin
  suspended          INTEGER NOT NULL DEFAULT 0,
  silenced           INTEGER NOT NULL DEFAULT 0,   -- 1 = posts hidden from public timelines, still visible to followers
  reserved           INTEGER NOT NULL DEFAULT 0,
  also_known_as      TEXT,                          -- JSON array of alias actor IRIs (account migration)
  moved_to           TEXT,                          -- actor IRI the account migrated to
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at     TEXT,
  UNIQUE (username, domain)
);

CREATE INDEX IF NOT EXISTS idx_actors_domain       ON actors(domain);
CREATE INDEX IF NOT EXISTS idx_actors_is_local     ON actors(is_local);
CREATE INDEX IF NOT EXISTS idx_actors_email        ON actors(email);
CREATE INDEX IF NOT EXISTS idx_actors_created_at   ON actors(created_at);
CREATE INDEX IF NOT EXISTS idx_actors_follow_followers ON actors(following_count, followers_count);

-- ─────────────────────────────────────────
-- Objects / Notes / Statuses
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS objects (
  id              TEXT PRIMARY KEY,          -- full AP IRI
  type            TEXT NOT NULL DEFAULT 'Note',
  actor_id        TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  content         TEXT,
  content_warning TEXT,
  sensitive       INTEGER NOT NULL DEFAULT 0,
  visibility      TEXT NOT NULL DEFAULT 'public',  -- public|unlisted|followers|direct
  in_reply_to_id  TEXT,
  language        TEXT,
  url             TEXT,
  replies_count   INTEGER NOT NULL DEFAULT 0,
  reblogs_count   INTEGER NOT NULL DEFAULT 0,
  favourites_count INTEGER NOT NULL DEFAULT 0,
  published       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  is_local        INTEGER NOT NULL DEFAULT 0,
  raw             TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_objects_actor_id    ON objects(actor_id);
CREATE INDEX IF NOT EXISTS idx_objects_published   ON objects(published DESC);
CREATE INDEX IF NOT EXISTS idx_objects_visibility  ON objects(visibility);
CREATE INDEX IF NOT EXISTS idx_objects_reply       ON objects(in_reply_to_id);

-- Composite indexes for the hot timeline queries (applied on fresh installs).
CREATE INDEX IF NOT EXISTS idx_objects_vis_published     ON objects(visibility, published DESC);
CREATE INDEX IF NOT EXISTS idx_objects_actor_vis_pub     ON objects(actor_id, visibility, published DESC);
CREATE INDEX IF NOT EXISTS idx_objects_reply_published   ON objects(in_reply_to_id, published ASC);

-- ─────────────────────────────────────────
-- Attachments
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,
  object_id   TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  type        TEXT NOT NULL DEFAULT 'image',
  url         TEXT NOT NULL,
  remote_url  TEXT,
  description TEXT,
  blurhash    TEXT,
  width       INTEGER,
  height      INTEGER,
  file_size   INTEGER,
  mime_type   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_attachments_object ON attachments(object_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_object_url ON attachments(object_id, url);

-- ─────────────────────────────────────────
-- Activities
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activities (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  actor_id    TEXT NOT NULL,
  object_id   TEXT,
  target_id   TEXT,
  to_list     TEXT NOT NULL DEFAULT '[]',   -- JSON array
  cc_list     TEXT NOT NULL DEFAULT '[]',   -- JSON array
  raw         TEXT NOT NULL DEFAULT '{}',
  published   TEXT NOT NULL DEFAULT (datetime('now')),
  is_local    INTEGER NOT NULL DEFAULT 0,
  delivered   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_activities_actor    ON activities(actor_id);
CREATE INDEX IF NOT EXISTS idx_activities_type     ON activities(type);
CREATE INDEX IF NOT EXISTS idx_activities_published ON activities(published DESC);

-- ─────────────────────────────────────────
-- Follows
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS follows (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  state       TEXT NOT NULL DEFAULT 'pending',  -- pending|accepted|rejected
  activity_id TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (actor_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_follows_actor    ON follows(actor_id, state);
CREATE INDEX IF NOT EXISTS idx_follows_target   ON follows(target_id, state);

-- ─────────────────────────────────────────
-- Likes / Favourites
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS likes (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  object_id   TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  activity_id TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (actor_id, object_id)
);

CREATE INDEX IF NOT EXISTS idx_likes_actor    ON likes(actor_id);
CREATE INDEX IF NOT EXISTS idx_likes_object   ON likes(object_id);

-- ─────────────────────────────────────────
-- Boosts / Announces
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS announces (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  object_id   TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  activity_id TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (actor_id, object_id)
);

CREATE INDEX IF NOT EXISTS idx_announces_actor  ON announces(actor_id);
CREATE INDEX IF NOT EXISTS idx_announces_object ON announces(object_id);

-- ─────────────────────────────────────────
-- Blocks
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS blocks (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (actor_id, target_id)
);

-- ─────────────────────────────────────────
-- Domain blocks (instance-level)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS domain_blocks (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  domain      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (actor_id, domain)
);

CREATE TABLE IF NOT EXISTS instance_domain_blocks (
  domain          TEXT PRIMARY KEY,
  severity        TEXT NOT NULL DEFAULT 'suspend',
  reject_media    INTEGER NOT NULL DEFAULT 1,
  reject_reports  INTEGER NOT NULL DEFAULT 1,
  private_comment TEXT,
  public_comment  TEXT,
  obfuscate       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────
-- Notifications
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id                TEXT PRIMARY KEY,
  type              TEXT NOT NULL,
  account_id        TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  target_account_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  object_id         TEXT,
  is_read           INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notif_target   ON notifications(target_account_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notif_created  ON notifications(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_dedup ON notifications(type, account_id, target_account_id, object_id);

-- ─────────────────────────────────────────
-- OAuth Apps
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oauth_apps (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  website       TEXT,
  redirect_uri  TEXT NOT NULL,
  scopes        TEXT NOT NULL DEFAULT 'read',
  client_id     TEXT NOT NULL UNIQUE,
  client_secret TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────
-- OAuth Tokens
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id            TEXT PRIMARY KEY,
  actor_id      TEXT,
  app_id        TEXT,
  access_token  TEXT NOT NULL UNIQUE,
  refresh_token TEXT,
  scope         TEXT NOT NULL DEFAULT 'read',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_tokens_token  ON oauth_tokens(access_token);
CREATE INDEX IF NOT EXISTS idx_tokens_actor  ON oauth_tokens(actor_id);

-- ─────────────────────────────────────────
-- Delivery queue state (fallback for failed deliveries)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS delivery_failures (
  id          TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL,
  inbox_url   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  next_retry  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────
-- Remote object cache (for thread resolution)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS object_cache (
  id          TEXT PRIMARY KEY,
  raw         TEXT NOT NULL,
  fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────
-- Actor profile fields (key/value pairs)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS actor_fields (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  value       TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (actor_id, position)
);

CREATE INDEX IF NOT EXISTS idx_actor_fields_actor ON actor_fields(actor_id);

-- ─────────────────────────────────────────
-- Polls
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS polls (
  id            TEXT PRIMARY KEY,
  object_id     TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  expires_at    TEXT NOT NULL,
  multiple      INTEGER NOT NULL DEFAULT 0,
  votes_count   INTEGER NOT NULL DEFAULT 0,
  voters_count  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_polls_object  ON polls(object_id);
CREATE INDEX IF NOT EXISTS idx_polls_expires ON polls(expires_at);

CREATE TABLE IF NOT EXISTS poll_options (
  id           TEXT PRIMARY KEY,
  poll_id      TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  votes_count  INTEGER NOT NULL DEFAULT 0,
  position     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_poll_opts_poll ON poll_options(poll_id, position);

CREATE TABLE IF NOT EXISTS poll_votes (
  id          TEXT PRIMARY KEY,
  poll_id     TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  actor_id    TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  option_idx  INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (poll_id, actor_id, option_idx)
);

CREATE INDEX IF NOT EXISTS idx_poll_votes_poll  ON poll_votes(poll_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_actor ON poll_votes(actor_id);

-- ─────────────────────────────────────────
-- Email verification tokens
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_verifications (
  id         TEXT PRIMARY KEY,
  actor_id   TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_verif_token ON email_verifications(token);
CREATE INDEX IF NOT EXISTS idx_email_verif_actor ON email_verifications(actor_id);

-- ─────────────────────────────────────────
-- Password reset tokens
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS password_resets (
  id         TEXT PRIMARY KEY,
  actor_id   TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token);
CREATE INDEX IF NOT EXISTS idx_password_resets_actor ON password_resets(actor_id);

-- ─────────────────────────────────────────
-- Custom emojis (local + federated)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS custom_emojis (
  id              TEXT PRIMARY KEY,
  shortcode       TEXT NOT NULL,
  url             TEXT NOT NULL,
  static_url      TEXT NOT NULL,
  category        TEXT,
  visible_in_picker INTEGER NOT NULL DEFAULT 1,
  domain          TEXT,                       -- source instance domain (null = local)
  actor_id        TEXT REFERENCES actors(id) ON DELETE SET NULL,
  disabled        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (shortcode, domain)
);

CREATE INDEX IF NOT EXISTS idx_custom_emojis_shortcode ON custom_emojis(shortcode);
CREATE INDEX IF NOT EXISTS idx_custom_emojis_domain    ON custom_emojis(domain);

-- ─────────────────────────────────────────
-- Followed hashtags (per user)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS followed_tags (
  id         TEXT PRIMARY KEY,
  actor_id   TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  tag_name   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (actor_id, tag_name)
);

CREATE INDEX IF NOT EXISTS idx_followed_tags_actor ON followed_tags(actor_id);

-- ─────────────────────────────────────────
-- Domain capabilities (call support, etc.)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS domain_capabilities (
  domain          TEXT PRIMARY KEY,
  supports_calls  INTEGER NOT NULL DEFAULT 0,
  checked_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────
-- Markers (timeline read positions)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS markers (
  id            TEXT PRIMARY KEY,
  actor_id      TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  timeline      TEXT NOT NULL,               -- 'home' | 'notifications'
  last_read_id  TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (actor_id, timeline)
);

CREATE INDEX IF NOT EXISTS idx_markers_actor ON markers(actor_id);

-- ─────────────────────────────────────────
-- Web Push subscriptions
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            TEXT PRIMARY KEY,
  actor_id      TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  endpoint      TEXT NOT NULL,
  p256dh_key    TEXT NOT NULL,
  auth_key      TEXT NOT NULL,
  standard      INTEGER NOT NULL DEFAULT 0,
  policy        TEXT NOT NULL DEFAULT 'all',
  alerts        TEXT NOT NULL DEFAULT '{}',
  server_key    TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (actor_id)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_actor ON push_subscriptions(actor_id);

-- ─────────────────────────────────────────
-- Bookmarks
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bookmarks (
  id            TEXT PRIMARY KEY,
  actor_id      TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  object_id     TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (actor_id, object_id)
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_actor ON bookmarks(actor_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_object ON bookmarks(object_id);

-- ─────────────────────────────────────────
-- Mutes
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mutes (
  id            TEXT PRIMARY KEY,
  actor_id      TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  target_id     TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  notifications INTEGER NOT NULL DEFAULT 1,
  duration      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (actor_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_mutes_actor ON mutes(actor_id);

-- ─────────────────────────────────────────
-- Lists
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lists (
  id              TEXT PRIMARY KEY,
  actor_id        TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  replies_policy  TEXT NOT NULL DEFAULT 'list',
  exclusive       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lists_actor ON lists(actor_id);

CREATE TABLE IF NOT EXISTS list_accounts (
  id          TEXT PRIMARY KEY,
  list_id     TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  actor_id    TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (list_id, actor_id)
);

CREATE INDEX IF NOT EXISTS idx_list_accounts_list ON list_accounts(list_id);
CREATE INDEX IF NOT EXISTS idx_list_accounts_actor ON list_accounts(actor_id);

-- ─────────────────────────────────────────
-- Conversations
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  actor_id      TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  last_status_id TEXT,
  unread        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conversations_actor ON conversations(actor_id);

-- ─────────────────────────────────────────
-- Collections (curated collections of accounts)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS collections (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  language      TEXT,
  tag_name      TEXT,
  sensitive     INTEGER NOT NULL DEFAULT 0,
  discoverable  INTEGER NOT NULL DEFAULT 0,
  local         INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_collections_account ON collections(account_id);

CREATE TABLE IF NOT EXISTS collection_items (
  id            TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  account_id    TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  state         TEXT NOT NULL DEFAULT 'accepted',
  created_at    TEXT NOT NULL,
  UNIQUE (collection_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_collection_items_collection ON collection_items(collection_id);
CREATE INDEX IF NOT EXISTS idx_collection_items_account ON collection_items(account_id);

-- ─────────────────────────────────────────
-- Filters (v2)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS filters (
  id              TEXT PRIMARY KEY,
  actor_id        TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  context         TEXT NOT NULL DEFAULT '[]',
  filter_action   TEXT NOT NULL DEFAULT 'warn',
  expires_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_filters_actor ON filters(actor_id);

CREATE TABLE IF NOT EXISTS filter_keywords (
  id          TEXT PRIMARY KEY,
  filter_id   TEXT NOT NULL REFERENCES filters(id) ON DELETE CASCADE,
  keyword     TEXT NOT NULL,
  whole_word  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_filter_keywords_filter ON filter_keywords(filter_id);

CREATE TABLE IF NOT EXISTS filter_statuses (
  id          TEXT PRIMARY KEY,
  filter_id   TEXT NOT NULL REFERENCES filters(id) ON DELETE CASCADE,
  status_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_filter_statuses_filter ON filter_statuses(filter_id);

-- ─────────────────────────────────────────
-- Scheduled statuses
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduled_statuses (
  id            TEXT PRIMARY KEY,
  actor_id      TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  scheduled_at  TEXT NOT NULL,
  params        TEXT NOT NULL DEFAULT '{}',
  media_ids     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scheduled_statuses_actor ON scheduled_statuses(actor_id);

-- ─────────────────────────────────────────
-- Reports
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reports (
  id              TEXT PRIMARY KEY,
  actor_id        TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  target_id       TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  status_ids      TEXT,
  comment         TEXT NOT NULL DEFAULT '',
  category        TEXT NOT NULL DEFAULT 'other',
  rule_ids        TEXT,
  forwarded       INTEGER NOT NULL DEFAULT 0,
  action_taken    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reports_actor ON reports(actor_id);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_id);

-- ─────────────────────────────────────────
-- Report notes (moderation discussion on a report)
-- Mirrors Mastodon's report_notes: internal-only notes between moderators
-- attached to a report ticket. Not federated (Mastodon does not federate
-- moderation notes).
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS report_notes (
  id         TEXT PRIMARY KEY,
  report_id  TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  actor_id   TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_report_notes_report ON report_notes(report_id);

-- ─────────────────────────────────────────
-- Moderation log (AI Guardian audit trail)
-- One row per automated moderation decision/action so every action the AI
-- takes on the instance can be audited later.
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS moderation_log (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  source      TEXT NOT NULL,                 -- 'ai' | 'heuristic' | 'system' | 'user'
  target_type TEXT NOT NULL,                 -- 'account' | 'status' | 'report' | 'domain' | 'instance'
  target_id   TEXT,                          -- actor id / object id / report id / domain / null
  action      TEXT NOT NULL,                 -- approved|rejected|warned|deleted|suspended|unsuspended|dismissed|resolved|marked_sensitive|blocked_domain|no_action
  reason      TEXT,
  confidence  TEXT,                          -- 'low' | 'medium' | 'high' (null for heuristics)
  model       TEXT,                          -- Workers AI model id, or 'heuristic', or 'system'
  details     TEXT,                          -- JSON with the full context used for the decision
  email_sent  INTEGER NOT NULL DEFAULT 0,    -- 1 if a notification email was sent
  email_to    TEXT,                          -- recipient of that email
  related_id  TEXT                           -- e.g. the report id / reporter id / status ids
);

CREATE INDEX IF NOT EXISTS idx_moderation_log_created ON moderation_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_moderation_log_target  ON moderation_log(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_moderation_log_action  ON moderation_log(action);

-- ─────────────────────────────────────────
-- Featured tags
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS featured_tags (
  id              TEXT PRIMARY KEY,
  actor_id        TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  tag_name        TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (actor_id, tag_name)
);

CREATE INDEX IF NOT EXISTS idx_featured_tags_actor ON featured_tags(actor_id);

-- ─────────────────────────────────────────
-- Announcements
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS announcements (
  id            TEXT PRIMARY KEY,
  content       TEXT NOT NULL,
  starts_at     TEXT,
  ends_at       TEXT,
  all_day       INTEGER NOT NULL DEFAULT 0,
  published_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS announcement_reactions (
  id              TEXT PRIMARY KEY,
  announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  actor_id        TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (announcement_id, actor_id, name)
);

CREATE INDEX IF NOT EXISTS idx_ann_reactions_ann ON announcement_reactions(announcement_id);

-- ─────────────────────────────────────────
-- Follow suggestions (dismissed)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dismissed_suggestions (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (actor_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_dismissed_suggestions_actor ON dismissed_suggestions(actor_id);

-- ─────────────────────────────────────────
-- Endorsements (account pinning)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS endorsements (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (actor_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_endorsements_actor ON endorsements(actor_id);
CREATE INDEX IF NOT EXISTS idx_endorsements_target ON endorsements(target_id);

-- ─────────────────────────────────────────
-- Status pins
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS status_pins (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  status_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (actor_id, status_id)
);

CREATE INDEX IF NOT EXISTS idx_status_pins_actor ON status_pins(actor_id);

-- ─────────────────────────────────────────
-- Object edit history
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS object_edits (
  id              TEXT PRIMARY KEY,
  object_id       TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  content         TEXT,
  content_warning TEXT,
  sensitive       INTEGER NOT NULL DEFAULT 0,
  raw             TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_object_edits_object ON object_edits(object_id, created_at);

-- ─────────────────────────────────────────
-- Account notes
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS account_notes (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  comment     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (actor_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_account_notes_actor ON account_notes(actor_id);
CREATE INDEX IF NOT EXISTS idx_account_notes_target ON account_notes(target_id);

-- ─────────────────────────────────────────
-- MLS (Messaging Layer Security) over ActivityPub
-- Key packages are published by a user on their own server so that others
-- can encrypt Welcome/PrivateMessage/PublicMessage to them (RFC 9420 draft).
-- Messages are the received/decryptable MLSTM content envelopes.
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mls_key_packages (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  object_id   TEXT NOT NULL,
  ciphersuite TEXT,
  media_type  TEXT,
  encoding    TEXT,
  content     TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mls_kp_actor ON mls_key_packages(actor_id, is_active);

CREATE TABLE IF NOT EXISTS mls_messages (
  id           TEXT NOT NULL,
  type         TEXT NOT NULL,
  actor_id     TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  object_id    TEXT,
  object_type  TEXT,
  conversation TEXT,
  media_type   TEXT,
  encoding     TEXT,
  content      TEXT,
  raw          TEXT NOT NULL DEFAULT '{}',
  published    TEXT NOT NULL DEFAULT (datetime('now')),
  is_local     INTEGER NOT NULL DEFAULT 0,
  delivered    INTEGER NOT NULL DEFAULT 0,
  -- One activity id is delivered to many recipients; dedup is per recipient.
  PRIMARY KEY (recipient_id, id)
);

CREATE INDEX IF NOT EXISTS idx_mls_msg_recipient ON mls_messages(recipient_id, published DESC);
CREATE INDEX IF NOT EXISTS idx_mls_msg_conv ON mls_messages(conversation);

-- ─────────────────────────────────────────
-- User preferences (Mastodon-compatible keys)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS preferences (
  actor_id   TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,             -- 'posting:default:visibility', 'reading:expand:media', ...
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (actor_id, key)
);

CREATE INDEX IF NOT EXISTS idx_preferences_actor ON preferences(actor_id);
