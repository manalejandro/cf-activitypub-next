-- Drop every table in the database, children before parents so FK
-- constraints don't block the drops. Use with `npm run db:drop`.
--
-- Regenerate after adding tables to lib/db/schema.sql.

-- Legacy tables left behind by pre-custom_filters migrations.
DROP TABLE IF EXISTS filter_statuses;
DROP TABLE IF EXISTS filter_keywords;
DROP TABLE IF EXISTS filters;

DROP TABLE IF EXISTS account_notes;
DROP TABLE IF EXISTS activities;
DROP TABLE IF EXISTS actor_fields;
DROP TABLE IF EXISTS announcement_reactions;
DROP TABLE IF EXISTS announces;
DROP TABLE IF EXISTS blocks;
DROP TABLE IF EXISTS bookmarks;
DROP TABLE IF EXISTS collection_items;
DROP TABLE IF EXISTS collections;
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS custom_emojis;
DROP TABLE IF EXISTS custom_filter_keywords;
DROP TABLE IF EXISTS custom_filter_statuses;
DROP TABLE IF EXISTS custom_filters;
DROP TABLE IF EXISTS dismissed_suggestions;
DROP TABLE IF EXISTS domain_blocks;
DROP TABLE IF EXISTS email_verifications;
DROP TABLE IF EXISTS endorsements;
DROP TABLE IF EXISTS featured_tags;
DROP TABLE IF EXISTS followed_tags;
DROP TABLE IF EXISTS follows;
DROP TABLE IF EXISTS likes;
DROP TABLE IF EXISTS list_accounts;
DROP TABLE IF EXISTS lists;
DROP TABLE IF EXISTS markers;
DROP TABLE IF EXISTS mls_key_packages;
DROP TABLE IF EXISTS mls_messages;
DROP TABLE IF EXISTS mutes;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS attachments;
DROP TABLE IF EXISTS object_edits;
DROP TABLE IF EXISTS object_tags;
DROP TABLE IF EXISTS poll_options;
DROP TABLE IF EXISTS poll_votes;
DROP TABLE IF EXISTS polls;
DROP TABLE IF EXISTS objects;
DROP TABLE IF EXISTS password_resets;
DROP TABLE IF EXISTS preferences;
DROP TABLE IF EXISTS push_subscriptions;
DROP TABLE IF EXISTS report_notes;
DROP TABLE IF EXISTS reports;
DROP TABLE IF EXISTS scheduled_statuses;
DROP TABLE IF EXISTS status_pins;
DROP TABLE IF EXISTS actors;
DROP TABLE IF EXISTS announcements;
DROP TABLE IF EXISTS delivery_failures;
DROP TABLE IF EXISTS delivery_rejections;
DROP TABLE IF EXISTS domain_capabilities;
DROP TABLE IF EXISTS instance_domain_blocks;
DROP TABLE IF EXISTS instances;
DROP TABLE IF EXISTS instance_settings;
DROP TABLE IF EXISTS moderation_log;
DROP TABLE IF EXISTS oauth_apps;
DROP TABLE IF EXISTS oauth_tokens;
DROP TABLE IF EXISTS object_cache;
