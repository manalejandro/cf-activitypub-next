import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";

export async function GET(_request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  return json({
    content: env.INSTANCE_DESCRIPTION ?? "Terms of service not configured.",
    updated_at: null,
  });
}
