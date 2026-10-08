import { json } from "@/lib/cf";
import { getInstanceSetting } from "@/lib/db";
import { env } from "cloudflare:workers";

// GET /api/v1/instance/extended_description
export async function GET(): Promise<Response> {
  const content = (await getInstanceSetting(env.DB, "extended_description")) ?? env.INSTANCE_DESCRIPTION ?? "";
  return json({
    updated_at: new Date().toISOString(),
    content,
  });
}
