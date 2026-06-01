import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";

// GET /api/v1/instance/extended_description
export async function GET(_request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  return json({
    updated_at: new Date().toISOString(),
    content: env.INSTANCE_DESCRIPTION ?? "",
  });
}
