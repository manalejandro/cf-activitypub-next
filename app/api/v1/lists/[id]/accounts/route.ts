import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getListById, getListAccountIds, addAccountsToList, removeAccountsFromList, getActorById } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const list = await getListById(env.DB, id);
  if (!list) return notFound();
  if (list.actor_id !== actor.id) return notFound();

  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? "40"), 80);
  const accountIds = await getListAccountIds(env.DB, id);
  const sliced = accountIds.slice(0, limit);

  const accounts = await Promise.all(
    sliced.map(async (aid) => {
      const a = await getActorById(env.DB, aid);
      return a ? serializeAccount(a, domain) : null;
    })
  );

  return json(accounts.filter(Boolean));
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const list = await getListById(env.DB, id);
  if (!list) return notFound();
  if (list.actor_id !== actor.id) return notFound();

  const contentType = request.headers.get("Content-Type") ?? "";
  let accountIds: string[] = [];

  if (contentType.includes("application/json")) {
    const body = await request.json() as Record<string, string[]>;
    accountIds = body.account_ids ?? [];
  } else {
    const form = await request.formData();
    accountIds = form.getAll("account_ids[]").map((v) => v.toString());
  }

  await addAccountsToList(env.DB, id, accountIds);
  return json({});
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const list = await getListById(env.DB, id);
  if (!list) return notFound();
  if (list.actor_id !== actor.id) return notFound();

  const url = new URL(request.url);
  const accountIds = url.searchParams.getAll("account_ids[]");

  await removeAccountsFromList(env.DB, id, accountIds);
  return json({});
}