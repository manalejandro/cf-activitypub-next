import { json } from "@/lib/cf";

// GET /api/v1/trends/links
// Returns trending links. We don't track link previews, so always empty.
export async function GET(): Promise<Response> {
  return json([]);
}
