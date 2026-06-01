-- Drop all tables (reverse creation order to respect FK constraints)
DROP TABLE IF EXISTS delivery_failures;
DROP TABLE IF EXISTS oauth_tokens;
DROP TABLE IF EXISTS oauth_apps;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS blocks;
DROP TABLE IF EXISTS announces;
DROP TABLE IF EXISTS likes;
DROP TABLE IF EXISTS follows;
DROP TABLE IF EXISTS attachments;
DROP TABLE IF EXISTS activities;
DROP TABLE IF EXISTS objects;
DROP TABLE IF EXISTS actors;
