// GET /api/v1/streaming/health
// Mastodon clients check this before opening a WebSocket connection.
export async function GET(): Promise<Response> {
  return new Response("OK", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
