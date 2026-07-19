import { type NextRequest } from "next/server";
import { json } from "@/lib/cf";

export async function GET(
  _request: NextRequest,
  _params: { params: Promise<{ id: string }> }
): Promise<Response> {
  return json([]);
}
