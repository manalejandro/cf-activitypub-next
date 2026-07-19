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
  reserved           INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (username, domain)
);

CREATE INDEX IF NOT EXISTS idx_actors_domain       ON actors(domain);
CREATE INDEX IF NOT EXISTS idx_actors_is_local     ON actors(is_local);
CREATE INDEX IF NOT EXISTS idx_actors_email        ON actors(email);

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
