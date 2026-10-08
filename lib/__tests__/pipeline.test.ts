import { describe, it, expect, vi, beforeEach } from "vitest";

const mockScreenContent = vi.hoisted(() => vi.fn());
const mockEvaluateContent = vi.hoisted(() => vi.fn());
const mockVectorPreScreen = vi.hoisted(() => vi.fn());
const mockWarnAccount = vi.hoisted(() => vi.fn());
const mockSuspendAccount = vi.hoisted(() => vi.fn());
const mockDeleteStatus = vi.hoisted(() => vi.fn());
const mockMarkStatusSensitive = vi.hoisted(() => vi.fn());
const mockRecordNoAction = vi.hoisted(() => vi.fn());
const mockCountWarnings = vi.hoisted(() => vi.fn());
const mockCacheContentVerdict = vi.hoisted(() => vi.fn());
const mockGetCachedContentVerdict = vi.hoisted(() => vi.fn());
const mockChargeAI = vi.hoisted(() => vi.fn());
const mockChargeGlobalAI = vi.hoisted(() => vi.fn());

vi.mock("@/lib/moderation/classifier", () => ({
  screenContent: mockScreenContent,
}));

vi.mock("@/lib/moderation/ai", () => ({
  evaluateContent: mockEvaluateContent,
}));

vi.mock("@/lib/moderation/vectors", () => ({
  vectorPreScreen: mockVectorPreScreen,
}));

vi.mock("@/lib/moderation/actions", () => ({
  warnAccount: mockWarnAccount,
  suspendAccount: mockSuspendAccount,
  deleteStatus: mockDeleteStatus,
  markStatusSensitive: mockMarkStatusSensitive,
  recordNoAction: mockRecordNoAction,
  GUARDIAN_MODEL: "cf/cloudflare/clef",
}));

vi.mock("@/lib/moderation/log", () => ({
  countWarnings: mockCountWarnings,
}));

vi.mock("@/lib/moderation/budget", () => ({
  isTrustedAuthor: (i: { accountAgeDays: number; statusesCount: number; warnings: number }) =>
    i.accountAgeDays >= 2 && i.statusesCount >= 5 && i.warnings === 0,
  getCachedContentVerdict: mockGetCachedContentVerdict,
  cacheContentVerdict: mockCacheContentVerdict,
  chargeAI: mockChargeAI,
  chargeGlobalAI: mockChargeGlobalAI,
  AI_UNITS_GUARD: 1,
  AI_UNITS_REASON: 25,
}));

import { screenStatus } from "@/lib/moderation/pipeline";

const ENV = { DB: {}, AI: {} } as unknown as Parameters<typeof screenStatus>[0];

function input(overrides: Record<string, unknown> = {}) {
  return {
    contentHtml: "<p>Hola, hoy hace buen día.</p>",
    spoilerText: "",
    mediaCount: 0,
    isReply: false,
    visibility: "public",
    authorId: "actor-1",
    authorUsername: "newbie",
    accountAgeDays: 0.1,
    statusesCount: 1,
    objectId: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCachedContentVerdict.mockResolvedValue(null);
  mockChargeAI.mockResolvedValue(true);
  mockChargeGlobalAI.mockResolvedValue(true);
  mockCountWarnings.mockResolvedValue(0);
  mockScreenContent.mockResolvedValue({ safe: true, categories: [], raw: "safe" });
  mockVectorPreScreen.mockResolvedValue({ autoAction: null, flagged: false, best: null, precedent: null });
  mockWarnAccount.mockResolvedValue({ action: "warned", applied: true, emailSent: false });
  mockSuspendAccount.mockResolvedValue({ action: "suspended", applied: true, emailSent: false });
  mockDeleteStatus.mockResolvedValue({ action: "deleted", applied: true, emailSent: false });
  mockMarkStatusSensitive.mockResolvedValue({ action: "sensitive", applied: true, emailSent: false });
  mockRecordNoAction.mockResolvedValue(undefined);
});

describe("screenStatus — heuristic-first (AI as last resort)", () => {
  it("blocks unmistakable spam on an unknown account without any AI call", async () => {
    const res = await screenStatus(ENV, input({ contentHtml: '<p><a href="https://x.com">https://x.com</a> <a href="https://y.com">https://y.com</a></p>' }));

    expect(res.blocked).toBe(true);
    expect(res.reason).toContain("heurísticas");
    expect(mockWarnAccount).toHaveBeenCalledTimes(1);
    expect(mockWarnAccount.mock.calls[0][1]).toMatchObject({ source: "heuristic", model: "heuristic" });
    expect(mockScreenContent).not.toHaveBeenCalled();
    expect(mockEvaluateContent).not.toHaveBeenCalled();
    expect(mockVectorPreScreen).not.toHaveBeenCalled();
    expect(mockChargeAI).not.toHaveBeenCalled();
  });

  it("suspends on repeat offence for unmistakable spam without AI", async () => {
    mockCountWarnings.mockResolvedValue(1);
    const res = await screenStatus(ENV, input({ contentHtml: '<p><a href="https://x.com">https://x.com</a> <a href="https://y.com">https://y.com</a></p>' }));

    expect(res.blocked).toBe(true);
    expect(mockSuspendAccount).toHaveBeenCalledTimes(1);
    expect(mockSuspendAccount.mock.calls[0][1]).toMatchObject({ source: "heuristic" });
    expect(mockEvaluateContent).not.toHaveBeenCalled();
  });

  it("allows clean content without links from a new author with zero AI calls", async () => {
    const res = await screenStatus(ENV, input({ contentHtml: "<p>Hola, hoy hace buen día en la ciudad.</p>" }));

    expect(res.blocked).toBe(false);
    expect(res.markedSensitive).toBe(false);
    expect(mockScreenContent).not.toHaveBeenCalled();
    expect(mockEvaluateContent).not.toHaveBeenCalled();
    expect(mockVectorPreScreen).not.toHaveBeenCalled();
    expect(mockChargeAI).not.toHaveBeenCalled();
  });

  it("trusted author mentioning a scam keyword is not auto-blocked (falls to AI)", async () => {
    const res = await screenStatus(
      ENV,
      input({
        contentHtml: "<p>Os cuento cómo funciona el bitcoin y el trabajo desde casa.</p>",
        accountAgeDays: 30,
        statusesCount: 50,
      })
    );

    // patron_estafa keyword, but trusted → not auto-blocked; goes to Llama Guard.
    expect(res.blocked).toBe(false);
    expect(mockWarnAccount).not.toHaveBeenCalled();
    expect(mockScreenContent).toHaveBeenCalledTimes(1);
    expect(mockEvaluateContent).not.toHaveBeenCalled();
  });

  it("content with links on a new author goes to Llama Guard (cheap tier)", async () => {
    const res = await screenStatus(
      ENV,
      input({ contentHtml: "<p>Mira este artículo <a href=\"https://x.com\">https://x.com</a></p>" })
    );

    expect(res.blocked).toBe(false);
    expect(mockScreenContent).toHaveBeenCalledTimes(1);
    expect(mockChargeAI).toHaveBeenCalledTimes(1);
  });
});
