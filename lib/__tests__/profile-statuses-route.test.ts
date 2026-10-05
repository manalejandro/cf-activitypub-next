// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LocalActor, LocalObject } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
  getAuthenticatedActor: vi.fn(),
  getActorById: vi.fn(),
  getActorsByIds: vi.fn(),
  getActorStatuses: vi.fn(),
  getActorStatuses_withReplies: vi.fn(),
  getActorBoosts: vi.fn(),
  getAttachmentsByObjectIds: vi.fn(),
  getLikedObjectIds: vi.fn(),
  getAnnouncedObjectIds: vi.fn(),
  getAllCustomEmojis: vi.fn(),
  isAcceptedFollower: vi.fn(),
  getReplyToAccountIdMap: vi.fn(),
  getObjectQuotesCounts: vi.fn(),
  getLastStatusAtMap: vi.fn(),
  getBookmarkedObjectIds: vi.fn(),
  getMutedActorIds: vi.fn(),
  getActorFieldsMap: vi.fn(),
  getFilterResultsForStatuses: vi.fn(),
  getQuotesByIds: vi.fn(),
  getStatusAuthorExtras: vi.fn(),
  loadSerializedPolls: vi.fn(),
  fetchAndCacheRemoteActorStatuses: vi.fn(),
  fetchAndCacheRemoteActorFeatured: vi.fn(),
}));

vi.mock("@/lib/cf", () => ({
  getCloudflareContext: mocks.getCloudflareContext,
  json: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
  notFound: (message = "Not found") => new Response(JSON.stringify({ error: message }), { status: 404 }),
  unauthorized: () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
}));
vi.mock("@/lib/auth", () => ({ getAuthenticatedActor: mocks.getAuthenticatedActor }));
vi.mock("@/lib/db", () => ({
  getActorById: mocks.getActorById,
  getActorsByIds: mocks.getActorsByIds,
  getActorStatuses: mocks.getActorStatuses,
  getActorStatuses_withReplies: mocks.getActorStatuses_withReplies,
  getActorBoosts: mocks.getActorBoosts,
  getAttachmentsByObjectIds: mocks.getAttachmentsByObjectIds,
  getLikedObjectIds: mocks.getLikedObjectIds,
  getAnnouncedObjectIds: mocks.getAnnouncedObjectIds,
  getAllCustomEmojis: mocks.getAllCustomEmojis,
  isAcceptedFollower: mocks.isAcceptedFollower,
  getReplyToAccountIdMap: mocks.getReplyToAccountIdMap,
  getObjectQuotesCounts: mocks.getObjectQuotesCounts,
  getLastStatusAtMap: mocks.getLastStatusAtMap,
  getBookmarkedObjectIds: mocks.getBookmarkedObjectIds,
  getMutedActorIds: mocks.getMutedActorIds,
  getActorFieldsMap: mocks.getActorFieldsMap,
}));
vi.mock("@/lib/activitypub/remote", () => ({
  fetchAndCacheRemoteActorStatuses: mocks.fetchAndCacheRemoteActorStatuses,
  fetchAndCacheRemoteActorFeatured: mocks.fetchAndCacheRemoteActorFeatured,
}));
vi.mock("@/lib/mastodon/filters", () => ({ getFilterResultsForStatuses: mocks.getFilterResultsForStatuses }));
vi.mock("@/lib/mastodon/account-extras", () => ({ getStatusAuthorExtras: mocks.getStatusAuthorExtras }));
vi.mock("@/lib/mastodon/quote", () => ({ getQuotesByIds: mocks.getQuotesByIds }));
vi.mock("@/lib/mastodon/serializers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mastodon/serializers")>()),
  loadSerializedPolls: mocks.loadSerializedPolls,
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/v1/accounts/[id]/statuses/route";

const PROFILE = {
  id: "https://cf-ap.com/users/ale",
  username: "ale",
  domain: "cf-ap.com",
  displayName: "ale",
  isLocal: true,
  avatarUrl: null,
  headerUrl: null,
} as unknown as LocalActor;

const BOB = {
  id: "https://other.example/users/bob",
  username: "bob",
  domain: "other.example",
  displayName: "Bob",
  isLocal: false,
  avatarUrl: null,
  headerUrl: null,
} as unknown as LocalActor;

const BOOSTED = {
  id: "https://other.example/objects/1",
  type: "Note",
  actorId: BOB.id,
  content: "<p>hola</p>",
  contentWarning: null,
  sensitive: false,
  visibility: "public",
  inReplyToId: null,
  quoteId: null,
  language: "es",
  url: "https://other.example/objects/1",
  repliesCount: 0,
  reblogsCount: 1,
  favouritesCount: 0,
  published: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  local: false,
  raw: "{}",
} as unknown as LocalObject;

function request(query: string): NextRequest {
  return new NextRequest(`https://cf-ap.com/api/v1/accounts/x/statuses?${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCloudflareContext.mockReturnValue({ env: { DB: {} } });
  mocks.getAuthenticatedActor.mockResolvedValue(null);
  mocks.getActorById.mockResolvedValue(PROFILE);
  mocks.isAcceptedFollower.mockResolvedValue(false);
  mocks.getActorStatuses.mockResolvedValue([]);
  mocks.getActorStatuses_withReplies.mockResolvedValue([]);
  mocks.getActorBoosts.mockResolvedValue([
    { object: BOOSTED, boost: { id: "ann-1", actorId: PROFILE.id, createdAt: "2026-01-02T00:00:00Z" } },
  ]);
  mocks.getAttachmentsByObjectIds.mockResolvedValue(new Map());
  mocks.getLikedObjectIds.mockResolvedValue(new Set());
  mocks.getAnnouncedObjectIds.mockResolvedValue(new Set());
  mocks.getAllCustomEmojis.mockResolvedValue([]);
  mocks.getReplyToAccountIdMap.mockResolvedValue(new Map());
  mocks.getObjectQuotesCounts.mockResolvedValue(new Map());
  mocks.getLastStatusAtMap.mockResolvedValue(new Map());
  mocks.getBookmarkedObjectIds.mockResolvedValue(new Set());
  mocks.getMutedActorIds.mockResolvedValue([]);
  mocks.getActorFieldsMap.mockResolvedValue(new Map());
  mocks.getFilterResultsForStatuses.mockResolvedValue(new Map());
  mocks.getQuotesByIds.mockResolvedValue(new Map());
  mocks.getStatusAuthorExtras.mockResolvedValue(new Map());
  mocks.loadSerializedPolls.mockResolvedValue(new Map());
  mocks.getActorsByIds.mockResolvedValue(new Map([[BOB.id, BOB], [PROFILE.id, PROFILE]]));
  mocks.fetchAndCacheRemoteActorStatuses.mockResolvedValue(undefined);
});

describe("GET /api/v1/accounts/:id/statuses?only_reblogs=true", () => {
  it("serializes the boosted object with its original author, not the profile owner", async () => {
    const res = await GET(request("only_reblogs=true") as never, {
      params: Promise.resolve({ id: encodeURIComponent(PROFILE.id) }),
    });
    expect(res.status).toBe(200);

    const body = await res.json() as { account: { id: string }; reblog: { account: { id: string } } | null }[];
    expect(body).toHaveLength(1);
    // The wrapper is the boost: the profile account boosted…
    expect(body[0].account.id).toBe(PROFILE.id);
    // …and the inner card is the original post by its real author.
    expect(body[0].reblog?.account.id).toBe(BOB.id);
  });

  it("does not fetch the remote outbox for the boosts tab", async () => {
    mocks.getActorById.mockResolvedValue({ ...PROFILE, isLocal: false } as unknown as LocalActor);
    await GET(request("only_reblogs=true") as never, {
      params: Promise.resolve({ id: encodeURIComponent(PROFILE.id) }),
    });
    expect(mocks.fetchAndCacheRemoteActorStatuses).not.toHaveBeenCalled();
  });
});
