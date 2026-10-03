import { getCloudflareContext, json } from "@/lib/cf";
import { cachedMediaUrl, listLicenses } from "@/lib/db";
import { licenseIconsForUrl } from "@/lib/licenses";

// GET /api/v1/licenses — licenses offered by this instance (FEP-6757).
//
// Public, like the rest of the instance configuration: every composer needs the
// catalogue before the user posts, and the list carries no secrets. Clients
// resolve `status.license_url` against it to render the badge.
export async function GET(): Promise<Response> {
  const { env } = getCloudflareContext();
  const licenses = await listLicenses(env.DB);
  const payload = await Promise.all(
    licenses.map(async (license) => ({
      id: license.id,
      name: license.name,
      url: license.url,
      // Serve the R2 copy while the media cache holds it: clients never
      // hotlink the origin (licensebuttons.net, a peer's instance…).
      icon: (await cachedMediaUrl(env.DB, license.icon)) ?? license.icon,
      // Fork Awesome badge keys set by the admin: the badge representation.
      badgeKeys: license.badgeKeys,
      // Badges of a known license URI, so clients without the image (or with a
      // custom license that has none) can still draw something meaningful.
      badges: licenseIconsForUrl(license.url),
    }))
  );
  return json(payload);
}
