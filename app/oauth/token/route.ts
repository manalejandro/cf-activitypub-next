// Re-export the token handler at /oauth/token (standard Mastodon path).
// Mastodon-compatible clients (e.g. Elk) call /oauth/token directly,
// not /api/oauth/token.
export { POST } from "@/app/api/oauth/token/route";
