// Direct ActivityPub shared inbox handler at /inbox.
// Bypasses the proxy rewriting (route files answer external POSTs directly).
export { POST } from "@/app/api/inbox/route";
