import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActorById: vi.fn(),
  rememberAbuse: vi.fn(),
  deleteByIds: vi.fn(),
  rows: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getActorById: mocks.getActorById }));
vi.mock("@/lib/moderation/vectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/moderation/vectors")>()),
  rememberAbuse: mocks.rememberAbuse,
}));

import { forgetSuspension, learnFromSuspension, MAX_LESSON_CHARS } from "@/lib/moderation/learn";

const ACTOR_ID = "https://local.example/users/spammer";

function envWith(rows: { content: string }[] = [], opts: { ai?: boolean; vectorize?: boolean } = {}) {
  return {
    DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) } as unknown as D1Database,
    AI: opts.ai === false ? undefined : ({} as Ai),
    VECTORIZE: opts.vectorize === false
      ? undefined
      : ({ deleteByIds: mocks.deleteByIds } as unknown as VectorizeIndex),
  };
}

beforeEach(() => {
  mocks.getActorById.mockReset().mockResolvedValue({
    id: ACTOR_ID,
    username: "spammer",
    displayName: "Ofertas Ya",
    summary: "gana dinero rápido",
    isLocal: true,
    domain: "local.example",
  });
  mocks.rememberAbuse.mockReset().mockResolvedValue(true);
  mocks.deleteByIds.mockReset().mockResolvedValue({ mutationId: "m1" });
  mocks.rows.mockReset();
});

describe("learnFromSuspension", () => {
  it("leads with the offending content and adds the posts and the profile", async () => {
    const env = envWith([{ content: "<p>compra ya</p>" }, { content: "gana dinero" }]);

    const lesson = await learnFromSuspension(env, {
      actorId: ACTOR_ID,
      reason: "spam repetido",
      model: "heuristic",
      content: "OFERTA IMPERDIBLE",
    });

    expect(lesson).toEqual({ id: `account:${ACTOR_ID}`, chars: expect.any(Number) });
    expect(mocks.rememberAbuse).toHaveBeenCalledTimes(1);
    const input = mocks.rememberAbuse.mock.calls[0][1] as { id: string; kind: string; action: string; text: string; confidence: string; model: string; reason: string };
    expect(input.id).toBe(`account:${ACTOR_ID}`);
    expect(input.kind).toBe("account");
    expect(input.action).toBe("suspend");
    expect(input.reason).toBe("spam repetido");
    // The offending text leads: it is what the content screening will match.
    expect(input.text.startsWith("OFERTA IMPERDIBLE")).toBe(true);
    expect(input.text).toContain("compra ya");
    expect(input.text).toContain("spammer");
    expect(input.text).toContain("gana dinero rápido");
  });

  it("learns from the profile alone when nobody quoted a post", async () => {
    const env = envWith([]);

    expect(await learnFromSuspension(env, { actorId: ACTOR_ID })).not.toBeNull();

    const input = mocks.rememberAbuse.mock.calls[0][1] as { text: string; confidence: string };
    expect(input.text).toContain("spammer");
    expect(input.text).toContain("Ofertas Ya");
    // A human or rule suspension is a confirmed decision, never "low".
    expect(input.confidence).toBe("high");
  });

  it("keeps a model's confidence but never stores a low one", async () => {
    await learnFromSuspension(envWith([]), { actorId: ACTOR_ID, confidence: "medium" });
    expect((mocks.rememberAbuse.mock.calls[0][1] as { confidence: string }).confidence).toBe("medium");

    mocks.rememberAbuse.mockClear();
    await learnFromSuspension(envWith([]), { actorId: ACTOR_ID, confidence: "low" });
    expect((mocks.rememberAbuse.mock.calls[0][1] as { confidence: string }).confidence).toBe("high");
  });

  it("caps what it embeds", async () => {
    const env = envWith([{ content: "x".repeat(2000) }]);
    await learnFromSuspension(env, { actorId: ACTOR_ID });
    const text = (mocks.rememberAbuse.mock.calls[0][1] as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(MAX_LESSON_CHARS);
  });

  it("does nothing without the vector memory", async () => {
    expect(await learnFromSuspension(envWith([], { ai: false }), { actorId: ACTOR_ID })).toBeNull();
    expect(await learnFromSuspension(envWith([], { vectorize: false }), { actorId: ACTOR_ID })).toBeNull();
    expect(mocks.rememberAbuse).not.toHaveBeenCalled();
  });

  it("stays quiet when there is nothing to remember", async () => {
    mocks.getActorById.mockResolvedValue({ id: ACTOR_ID, username: "a", displayName: null, summary: null, isLocal: true, domain: "local.example" });
    expect(await learnFromSuspension(envWith([]), { actorId: ACTOR_ID })).toBeNull();
    expect(mocks.rememberAbuse).not.toHaveBeenCalled();
  });

  it("reports nothing when the memory rejects the store", async () => {
    mocks.rememberAbuse.mockResolvedValue(false);
    expect(await learnFromSuspension(envWith([]), { actorId: ACTOR_ID })).toBeNull();
  });
});

describe("forgetSuspension", () => {
  it("drops the account's lesson", async () => {
    expect(await forgetSuspension(envWith([]), ACTOR_ID)).toBe(true);
    expect(mocks.deleteByIds).toHaveBeenCalledWith([`account:${ACTOR_ID}`]);
  });

  it("does nothing without the vector memory", async () => {
    expect(await forgetSuspension(envWith([], { vectorize: false }), ACTOR_ID)).toBe(false);
    expect(mocks.deleteByIds).not.toHaveBeenCalled();
  });
});
