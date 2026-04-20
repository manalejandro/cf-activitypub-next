import { getCloudflareContext, json } from "@/lib/cf";

// GET /.well-known/nodeinfo
export async function GET(request: Request): Promise<Response> {
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  return json({
    links: [
      {
        rel: "http://nodeinfo.diaspora.software/ns/schema/2.1",
        href: `${baseUrl}/nodeinfo/2.1`,
      },
      {
        rel: "http://nodeinfo.diaspora.software/ns/schema/2.0",
        href: `${baseUrl}/nodeinfo/2.0`,
      },
    ],
  });
}
