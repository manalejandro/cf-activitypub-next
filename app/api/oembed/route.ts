import { type NextRequest } from "next/server";
import { getCloudflareContext, json, getBaseUrl } from "@/lib/cf";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const url = request.nextUrl.searchParams.get("url");
  if (!url) return json({ error: "url is required" }, 422);

  return json({
    type: "rich",
    version: "1.0",
    title: "a post",
    author_name: domain,
    author_url: `https://${domain}`,
    provider_name: "CF ActivityPub",
    provider_url: `https://${domain}`,
    cache_age: 86400,
    html: `<iframe src="${url}/embed" sandbox="allow-scripts" style="width: 100%; max-width: 400px; border: none"></iframe>`,
    width: 400,
    height: null,
  });
}