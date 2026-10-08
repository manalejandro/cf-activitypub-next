// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  CLEF,
  CLEF_FLASH,
  confidenceFromProbability,
  pickChoice,
  runClef,
  signalsReason,
  type ClefAnswers,
} from "@/lib/moderation/clef";
import { evaluateContent } from "@/lib/moderation/ai";

function fakeAi(response: unknown) {
  const run = vi.fn(async () => response);
  return { ai: { run } as unknown as Ai, run };
}

const CONTENT = {
  content: "compra seguidores baratos en mi web",
  contentWarning: "",
  mediaCount: 0,
  isReply: false,
  visibility: "public",
  authorUsername: "spammy",
  accountAgeDays: 1,
  statusesCount: 40,
  previousWarnings: 0,
  flags: ["patron_estafa"],
  precedent: null,
};

describe("runClef", () => {
  it("sends the model selector, the state and the questions", async () => {
    const { ai, run } = fakeAi({ answers: { unsafe: { type: "noul", noul: 0.8 } } });
    const answers = await runClef(ai, CLEF_FLASH, { content: "hola" }, {
      unsafe: { type: "noul", instructions: "Is it unsafe?" },
    });
    expect(answers?.unsafe).toEqual({ type: "noul", noul: 0.8 });

    const [model, input] = run.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(model).toBe(CLEF_FLASH);
    expect(input).toMatchObject({
      model: "clef-flash",
      state: { content: "hola" },
      questions: { unsafe: { type: "noul" } },
    });
  });

  it("returns null on failure or malformed output", async () => {
    const failing = { run: vi.fn(async () => { throw new Error("unavailable"); }) } as unknown as Ai;
    expect(await runClef(failing, CLEF, { content: "x" }, { unsafe: { type: "noul", instructions: "?" } })).toBeNull();
    // A failed attempt is retried once before giving up.
    expect((failing as unknown as { run: ReturnType<typeof vi.fn> }).run).toHaveBeenCalledTimes(2);

    const empty = { run: vi.fn(async () => ({})) } as unknown as Ai;
    expect(await runClef(empty, CLEF, { content: "x" }, { unsafe: { type: "noul", instructions: "?" } })).toBeNull();
  });

  it("recovers when the retry succeeds", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("cold start"))
      .mockResolvedValueOnce({ answers: { unsafe: { type: "noul", noul: 0.9 } } });
    const ai = { run } as unknown as Ai;
    const answers = await runClef(ai, CLEF_FLASH, { content: "x" }, { unsafe: { type: "noul", instructions: "?" } });
    expect(answers?.unsafe).toEqual({ type: "noul", noul: 0.9 });
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("clef answer helpers", () => {
  const answers: ClefAnswers = {
    action: {
      type: "choice",
      choice: "delete",
      probabilities: { allow: 0.05, delete: 0.8, escalate: 0.1, mark_sensitive: 0.05 },
      confidence: 0.8,
    },
    spam: { type: "noul", noul: 0.92 },
    scam: { type: "noul", noul: 0.6 },
    hate: { type: "noul", noul: 0.2 },
  };

  it("picks the chosen option with its probability", () => {
    expect(pickChoice(answers, "action")).toEqual({ option: "delete", probability: 0.8, confidence: 0.8 });
    expect(pickChoice(answers, "missing")).toBeNull();
    expect(pickChoice(answers, "spam")).toBeNull();
  });

  it("synthesizes the reason from the strongest signals", () => {
    expect(signalsReason(answers, { spam: "spam", scam: "estafa", hate: "odio" }))
      .toBe("spam (92%), estafa (60%)");
    expect(signalsReason(answers, { hate: "odio" })).toBeNull();
  });

  it("maps probabilities to confidence", () => {
    expect(confidenceFromProbability(0.9)).toBe("high");
    expect(confidenceFromProbability(0.5)).toBe("medium");
    expect(confidenceFromProbability(0.3)).toBe("low");
  });
});

describe("evaluateContent (clef)", () => {
  it("turns clef answers into a Guardian verdict", async () => {
    const { ai } = fakeAi({
      answers: {
        action: {
          type: "choice",
          choice: "delete",
          probabilities: { allow: 0.05, delete: 0.8, escalate: 0.1, mark_sensitive: 0.05 },
          confidence: 0.8,
        },
        spam: { type: "noul", noul: 0.92 },
        scam: { type: "noul", noul: 0.7 },
      },
    });
    const verdict = await evaluateContent({ AI: ai }, CONTENT);
    expect(verdict).toEqual({ action: "delete", reason: "spam (92%), estafa (70%)", confidence: "high" });
  });

  it("falls back to a generic reason when no signal passes the threshold", async () => {
    const { ai } = fakeAi({
      answers: {
        action: { type: "choice", choice: "allow", probabilities: { allow: 0.85 }, confidence: 0.85 },
      },
    });
    const verdict = await evaluateContent({ AI: ai }, CONTENT);
    expect(verdict).toEqual({ action: "allow", reason: "Revisado y permitido por el Guardian.", confidence: "high" });
  });

  it("returns null when the model answers outside the allowed action set", async () => {
    const { ai } = fakeAi({
      answers: { action: { type: "choice", choice: "suspend", probabilities: { suspend: 0.9 }, confidence: 0.9 } },
    });
    expect(await evaluateContent({ AI: ai }, CONTENT)).toBeNull();
  });

  it("returns null without an AI binding", async () => {
    expect(await evaluateContent({}, CONTENT)).toBeNull();
  });
});
