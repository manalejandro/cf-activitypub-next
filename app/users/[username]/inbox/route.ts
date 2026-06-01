// Direct ActivityPub per-user inbox handler at /users/[username]/inbox.
// Bypasses Next.js middleware rewriting (unreliable for external POST in OpenNext/Cloudflare).
export { POST, GET } from "@/app/api/users/[username]/inbox/route";
