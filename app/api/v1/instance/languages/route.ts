import { getCloudflareContext, json } from "@/lib/cf";
import { getInstanceSetting } from "@/lib/db";
import { SUPPORTED_LANGUAGES } from "@/lib/locales/supported";

export async function GET(): Promise<Response> {
  const { env } = getCloudflareContext();
  const raw = await getInstanceSetting(env.DB, "languages");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { code: string; name?: string; native_name?: string }[];
      if (parsed.length > 0) return json(parsed);
    } catch { /* fall through */ }
  }
  return json(SUPPORTED_LANGUAGES);
}
