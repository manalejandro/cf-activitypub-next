import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const { id } = await params;

  // Delete all domain blocks by this user for this domain
  // The id here is a sequential number, we need to look up the actual domain
  const rows = await env.DB
    .prepare("SELECT domain FROM domain_blocks GROUP BY domain")
    .all<{ domain: string }>();

  const idx = parseInt(id) - 1;
  if (idx < 0 || idx >= rows.results.length) return notFound();

  const domain = rows.results[idx].domain;
  await env.DB.prepare("DELETE FROM domain_blocks WHERE domain = ?").bind(domain).run();

  return json({});
}
