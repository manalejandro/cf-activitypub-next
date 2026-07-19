import { type NextRequest } from "next/server";
import { json } from "@/lib/cf";

export async function GET(_request: NextRequest): Promise<Response> {
  return json([]);
}
