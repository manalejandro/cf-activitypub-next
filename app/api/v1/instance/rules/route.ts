import { json } from "@/lib/cf";
import { getInstanceSetting } from "@/lib/db";
import { env } from "cloudflare:workers";

export async function GET(): Promise<Response> {
  const raw = await getInstanceSetting(env.DB, "rules");
  try {
    const rules = raw ? JSON.parse(raw) : [];
    return json(Array.isArray(rules) ? rules : []);
  } catch {
    return json([]);
  }
}
