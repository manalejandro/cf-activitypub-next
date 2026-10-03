import { getCloudflareContext, json } from "@/lib/cf";
import { listLicenses } from "@/lib/db";

// GET /api/v1/licenses — licenses offered by this instance (FEP-6757).
//
// Public, like the rest of the instance configuration: every composer needs the
// catalogue before the user posts, and the list carries no secrets. Clients
// resolve `status.license_url` against it to render the badge.
export async function GET(): Promise<Response> {
  const { env } = getCloudflareContext();
  const licenses = await listLicenses(env.DB);
  return json(
    licenses.map((license) => ({
      id: license.id,
      name: license.name,
      url: license.url,
      icon: license.icon,
    }))
  );
}
