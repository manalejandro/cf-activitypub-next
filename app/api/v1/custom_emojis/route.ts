import { type NextRequest } from "next/server";
import { json } from "@/lib/cf";

// GET /api/v1/custom_emojis — Return an empty list (custom emoji not yet implemented)
export async function GET(_request: NextRequest): Promise<Response> {
  return json([]);
}
