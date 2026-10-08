import { json } from "@/lib/cf";
import { getInstanceSetting } from "@/lib/db";
import { env } from "cloudflare:workers";

export async function GET(): Promise<Response> {
  const content = (await getInstanceSetting(env.DB, "privacy_policy")) ?? "";
  return json({
    content,
    updated_at: content ? new Date().toISOString() : null,
  });
}
