import { getCloudflareContext, json } from "@/lib/cf";
import { getInstanceSetting } from "@/lib/db";

export async function GET(): Promise<Response> {
  const { env } = getCloudflareContext();
  const content = (await getInstanceSetting(env.DB, "privacy_policy")) ?? "";
  return json({
    content,
    updated_at: content ? new Date().toISOString() : null,
  });
}
