import { getCloudflareContext, json } from "@/lib/cf";
import { getInstanceDomainBlocks } from "@/lib/db";

export async function GET(): Promise<Response> {
  const { env } = getCloudflareContext();
  const blocks = await getInstanceDomainBlocks(env.DB);
  return json(blocks.map((b) => b.domain));
}
