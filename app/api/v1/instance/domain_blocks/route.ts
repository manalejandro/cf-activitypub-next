import { json } from "@/lib/cf";
import { getInstanceDomainBlocks } from "@/lib/db";
import { env } from "cloudflare:workers";

export async function GET(): Promise<Response> {
  const blocks = await getInstanceDomainBlocks(env.DB);
  return json(blocks.map((b) => b.domain));
}
