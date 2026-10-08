// Direct ActivityPub per-user inbox handler at /users/[username]/inbox.
// Bypasses the proxy rewriting (route files answer external POSTs directly).
export { POST } from "@/app/api/users/[username]/inbox/route";
