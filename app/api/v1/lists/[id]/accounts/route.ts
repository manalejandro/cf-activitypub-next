import { type NextRequest } from "next/server";
import { json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getListById, getListAccountIds, addAccountsToList, removeAccountsFromList, getActorsByIds, getAllCustomEmojis } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { clampLimit, resolveLimits, MAX_LIST_ACCOUNT_IDS } from "@/lib/constants";
import type { LocalActor } from "@/lib/types";
import { env } from "cloudflare:workers";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const list = await getListById(env.DB, id);
  if (!list) return notFound();
  if (list.actor_id !== actor.id) return notFound();

  const limit = clampLimit(request.nextUrl.searchParams.get("limit"), limits.pageSize, limits.maxCollectionPage);
  const accountIds = await getListAccountIds(env.DB, id);
  const sliced = accountIds.slice(0, limit);

  // One batched lookup (never a query per account); the map restores the
  // list's own ordering. Bios render custom emoji, so the catalogue is loaded
  // like every other account-listing route.
  const [accountsById, allEmojis] = await Promise.all([
    getActorsByIds(env.DB, sliced),
    getAllCustomEmojis(env.DB),
  ]);
  return json(
    sliced
      .map((aid) => accountsById.get(aid))
      .filter((a): a is LocalActor => Boolean(a))
      .map((a) => serializeAccount(a, domain, { emojis: allEmojis }))
  );
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {

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
  // Bounded: one request cannot name an arbitrary number of accounts.
  accountIds = accountIds.filter((v) => typeof v === "string").slice(0, MAX_LIST_ACCOUNT_IDS);

  await addAccountsToList(env.DB, id, accountIds);
  return json({});
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const list = await getListById(env.DB, id);
  if (!list) return notFound();
  if (list.actor_id !== actor.id) return notFound();

  const url = new URL(request.url);
  const accountIds = url.searchParams.getAll("account_ids[]").slice(0, MAX_LIST_ACCOUNT_IDS);

  await removeAccountsFromList(env.DB, id, accountIds);
  return json({});
}