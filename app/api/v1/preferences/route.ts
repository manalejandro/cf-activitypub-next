import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  // Default preferences — these mirror the hardcoded defaults in
  // Mastodon's CredentialAccount#source and PreferencesSerializer.
  return json({
    "posting:default:visibility": "public",
    "posting:default:sensitive": false,
    "posting:default:language": null,
    "posting:default:quote_policy": "followers",
    "reading:expand:media": "default",
    "reading:expand:spoilers": false,
  });
}
