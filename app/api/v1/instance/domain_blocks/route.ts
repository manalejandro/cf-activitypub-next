import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";

export async function GET(_request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const rows = await env.DB
    .prepare("SELECT DISTINCT domain FROM domain_blocks ORDER BY domain")
    .all<{ domain: string }>();
  return json(rows.results.map((r) => r.domain));
}
