import { getCloudflareContext, json } from "@/lib/cf";
import { getInstanceSetting } from "@/lib/db";

export async function GET(): Promise<Response> {
  const { env } = getCloudflareContext();
  const raw = await getInstanceSetting(env.DB, "rules");
  try {
    const rules = raw ? JSON.parse(raw) : [];
    return json(Array.isArray(rules) ? rules : []);
  } catch {
    return json([]);
  }
}
