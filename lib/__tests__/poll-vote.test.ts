// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

import { buildVote } from "@/lib/activitypub/utils";

const mocks = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
  enqueueDeliveries: vi.fn(async () => {}),
  getPollById: vi.fn(),
  getObjectById: vi.fn(),
  getPollOptions: vi.fn(),
  getPollVotesByActor: vi.fn(async () => []),
  createPollVotes: vi.fn(async () => {}),
  getActorById: vi.fn(),
  canViewStatus: vi.fn(() => true),
  isAcceptedFollower: vi.fn(async () => false),
  getAuthenticatedActor: vi.fn(),
}));

vi.mock("@/lib/cf", () => ({
  getCloudflareContext: mocks.getCloudflareContext,
  json: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
  notFound: (msg = "Not found") => new Response(JSON.stringify({ error: msg }), { status: 404 }),
  unauthorized: () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
}));
vi.mock("@/lib/db", () => ({
  getPollById: mocks.getPollById,
  getObjectById: mocks.getObjectById,
  getPollOptions: mocks.getPollOptions,
  getPollVotesByActor: mocks.getPollVotesByActor,
  createPollVotes: mocks.createPollVotes,
  getActorById: mocks.getActorById,
  canViewStatus: mocks.canViewStatus,
  isAcceptedFollower: mocks.isAcceptedFollower,
}));
vi.mock("@/lib/auth", () => ({ getAuthenticatedActor: mocks.getAuthenticatedActor }));
vi.mock("@/lib/activitypub/queue", () => ({ enqueueDeliveries: mocks.enqueueDeliveries }));
vi.mock("@/lib/mastodon/serializers", () => ({
  serializePoll: (poll: { id: string }) => ({ id: poll.id, voted: true, own_votes: [0] }),
}));

const POLL_ID = "poll-1";
const POLL_OBJECT = "https://remote.example/objects/poll";
const AUTHOR = "https://remote.example/users/author";

describe("buildVote", () => {
  it("serializes Mastodon's vote shape (Create Note with name + inReplyTo)", () => {
    const activity = buildVote("https://local.example", "https://local.example/users/me", POLL_OBJECT, "Option A", "act-1", [AUTHOR]);
    expect(activity.type).toBe("Create");
    const note = activity.object as unknown as Record<string, unknown>;
    expect(note.type).toBe("Note");
    expect(note.name).toBe("Option A");
    expect(note.inReplyTo).toBe(POLL_OBJECT);
    expect(note.attributedTo).toBe("https://local.example/users/me");
    expect(activity.to).toEqual([AUTHOR]);
  });
});

describe("POST /api/v1/polls/:id/votes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCloudflareContext.mockReturnValue({
      env: { DB: {}, KV: {}, DELIVERY_QUEUE: {} },
    });
    mocks.getAuthenticatedActor.mockResolvedValue({
      id: "https://local.example/users/me",
      domain: "local.example",
      privateKeyPem: "pem",
    });
    mocks.getPollById.mockResolvedValue({
      id: POLL_ID,
      objectId: POLL_OBJECT,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      multiple: false,
    });
    mocks.getObjectById.mockResolvedValue({ id: POLL_OBJECT, local: false, actorId: AUTHOR });
    mocks.getPollOptions.mockResolvedValue([{ title: "Option A" }, { title: "Option B" }]);
    mocks.getActorById.mockResolvedValue({
      id: AUTHOR,
      isLocal: false,
      inbox: "https://remote.example/users/author/inbox",
      endpoints: undefined,
    });
  });

  it("federates the vote to the remote poll author", async () => {
    const { POST } = await import("@/app/api/v1/polls/[id]/votes/route");
    const res = await POST(
      new Request("https://local.example/api/v1/polls/poll-1/votes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choices: [0] }),
      }) as never,
      { params: Promise.resolve({ id: POLL_ID }) }
    );

    expect(res.status).toBe(200);
    expect(mocks.createPollVotes).toHaveBeenCalledWith(expect.anything(), POLL_ID, "https://local.example/users/me", [0]);
    expect(mocks.enqueueDeliveries).toHaveBeenCalledTimes(1);
    const [, inboxes, activityJson] = mocks.enqueueDeliveries.mock.calls[0] as unknown as [unknown, string[], string];
    expect(inboxes).toEqual(["https://remote.example/users/author/inbox"]);
    const activity = JSON.parse(activityJson) as Record<string, unknown>;
    expect(activity.type).toBe("Create");
    expect((activity.object as Record<string, unknown>).name).toBe("Option A");
  });

  it("does not federate votes on local polls", async () => {
    mocks.getObjectById.mockResolvedValue({ id: POLL_OBJECT, local: true, actorId: "https://local.example/users/author" });
    const { POST } = await import("@/app/api/v1/polls/[id]/votes/route");
    const res = await POST(
      new Request("https://local.example/api/v1/polls/poll-1/votes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choices: [1] }),
      }) as never,
      { params: Promise.resolve({ id: POLL_ID }) }
    );
    expect(res.status).toBe(200);
    expect(mocks.enqueueDeliveries).not.toHaveBeenCalled();
  });
});
