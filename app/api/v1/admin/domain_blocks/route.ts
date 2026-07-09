import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  const rows = await env.DB
    .prepare("SELECT domain FROM domain_blocks GROUP BY domain")
    .all<{ domain: string }>();

  return json(rows.results.map((r, i) => ({
    id: String(i + 1),
    domain: r.domain,
    created_at: new Date().toISOString(),
    severity: "silence",
    reject_media: false,
    reject_reports: false,
    private_comment: null,
    public_comment: null,
    obfuscate: false,
  })));
}
