// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  verifyIncomingSignature: vi.fn(),
  purgeGoneSignerData: vi.fn(async () => false),
  processInboxActivity: vi.fn(async () => {}),
  getActorById: vi.fn(async (): Promise<unknown> => null),
  getObjectById: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock("@/lib/cf", () => ({
  json: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
}));
vi.mock("cloudflare:workers", () => ({ get env() { return mocks.env; } }));
vi.mock("@/lib/activitypub/signer-key", () => ({
  verifyIncomingSignature: mocks.verifyIncomingSignature,
  purgeGoneSignerData: mocks.purgeGoneSignerData,
}));
vi.mock("@/lib/activitypub/inbox", () => ({ processInboxActivity: mocks.processInboxActivity }));
vi.mock("@/lib/db", () => ({
  getActorById: mocks.getActorById,
  getObjectById: mocks.getObjectById,
}));

import { POST } from "@/app/api/inbox/route";

const ACTOR = "https://masto.es/ap/users/117191738184183786";
const NOTE = "https://masto.es/ap/users/117191738184183786/statuses/1";

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("https://cf-ap.com/inbox", {
    method: "POST",
    headers: {
      "content-type": "application/activity+json",
      signature: `keyId="${ACTOR}#rsa-abc",algorithm="rsa-sha256",headers="(request-target) host date",signature="xx"`,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.purgeGoneSignerData.mockResolvedValue(false);
  mocks.getActorById.mockResolvedValue(null);
  mocks.getObjectById.mockResolvedValue(null);
  mocks.env = { DB: { prepare: () => ({ first: async () => null }) }, KV: {} };
});

describe("POST /inbox — unverifiable Delete", () => {
  it("acks a self-delete of an uncached actor instead of retrying forever", async () => {
    mocks.verifyIncomingSignature.mockResolvedValue({ ok: false, reason: "no-key", status: 525 });

    const res = await POST(makeRequest({ type: "Delete", actor: ACTOR, object: ACTOR }) as never);

    expect(res.status).toBe(202);
    expect(mocks.getActorById).toHaveBeenCalledWith(expect.anything(), ACTOR);
    expect(mocks.processInboxActivity).not.toHaveBeenCalled();
  });

  it("acks a Delete of an uncached object", async () => {
    mocks.verifyIncomingSignature.mockResolvedValue({ ok: false, reason: "no-key", status: 525 });

    const res = await POST(makeRequest({ type: "Delete", actor: ACTOR, object: NOTE }) as never);

    expect(res.status).toBe(202);
    expect(mocks.getObjectById).toHaveBeenCalledWith(expect.anything(), NOTE);
  });

  it("keeps retrying (503) when the signer is cached: it may own stored data", async () => {
    mocks.verifyIncomingSignature.mockResolvedValue({ ok: false, reason: "no-key", status: 525 });
    mocks.getActorById.mockResolvedValue({ id: ACTOR, isLocal: false });

    const res = await POST(makeRequest({ type: "Delete", actor: ACTOR, object: ACTOR }) as never);

    expect(res.status).toBe(503);
  });

  it("keeps retrying (503) when the target object is cached", async () => {
    mocks.verifyIncomingSignature.mockResolvedValue({ ok: false, reason: "no-key", status: 525 });
    mocks.getObjectById.mockResolvedValue({ id: NOTE, actorId: ACTOR });

    const res = await POST(makeRequest({ type: "Delete", actor: ACTOR, object: NOTE }) as never);

    expect(res.status).toBe(503);
  });

  it("does not ack other activity types without a key", async () => {
    mocks.verifyIncomingSignature.mockResolvedValue({ ok: false, reason: "no-key", status: 525 });

    const res = await POST(
      makeRequest({ type: "Create", actor: ACTOR, object: { id: NOTE, type: "Note" } }) as never
    );

    expect(res.status).toBe(503);
    expect(mocks.processInboxActivity).not.toHaveBeenCalled();
  });

  it("still purges and acks a Delete the origin reports as gone", async () => {
    mocks.verifyIncomingSignature.mockResolvedValue({ ok: false, reason: "gone", status: 410 });
    mocks.purgeGoneSignerData.mockResolvedValue(true);

    const res = await POST(makeRequest({ type: "Delete", actor: ACTOR, object: ACTOR }) as never);

    expect(res.status).toBe(202);
    expect(mocks.purgeGoneSignerData).toHaveBeenCalled();
  });

  it("returns 401 for a bad signature", async () => {
    mocks.verifyIncomingSignature.mockResolvedValue({ ok: false, reason: "invalid" });

    const res = await POST(makeRequest({ type: "Delete", actor: ACTOR, object: ACTOR }) as never);

    expect(res.status).toBe(401);
  });
});

describe("POST /inbox — verified activity", () => {
  it("processes the activity and acks", async () => {
    mocks.verifyIncomingSignature.mockResolvedValue({ ok: true, reason: "ok" });

    const res = await POST(makeRequest({ type: "Delete", actor: ACTOR, object: ACTOR }) as never);

    expect(res.status).toBe(202);
    expect(mocks.processInboxActivity).toHaveBeenCalledTimes(1);
  });
});
