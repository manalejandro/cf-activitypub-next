// Direct ActivityPub shared inbox handler at /inbox.
// Bypasses Next.js middleware rewriting (unreliable for external POST in OpenNext/Cloudflare).
export { POST } from "@/app/api/inbox/route";
