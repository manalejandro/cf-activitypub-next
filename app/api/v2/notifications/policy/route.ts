import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";

const DEFAULT_POLICY = {
  for_not_following: "accept" as const,
  for_not_followers: "accept" as const,
  for_new_accounts: "accept" as const,
  for_private_mentions: "accept" as const,
  for_limited_accounts: "accept" as const,
  summary: {
    pending_requests_count: 0,
    pending_notifications_count: 0,
  },
};

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  return json(DEFAULT_POLICY);
}

export async function PATCH(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  return json(DEFAULT_POLICY);
}
