-- Migration v2: polls + auto-delete
-- Run once on existing deployments:
--   wrangler d1 execute cf-activitypub --remote --file=lib/db/migrate_v2.sql

ALTER TABLE actors ADD COLUMN auto_delete_after INTEGER;

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
