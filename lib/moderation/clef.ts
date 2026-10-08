/**
 * Clef decision client (@cf/cloudflare/clef).
 *
 * Clef is a decision model, not a chat model: it takes a `state` (untrusted
 * data — text or structured JSON) plus a schema of typed questions
 * (`noul` = yes/no probability, `choice`, `score`) and returns a probability
 * for every option instead of free text. The Guardian uses it in two tiers:
 *
 *  - **`clef-flash`** (9B, $0.09/M input tokens) for the first-line screen on
 *    every new status, where only volume matters.
 *  - **`clef`** (27B, $0.24/M) for the reasoning decisions (report, content,
 *    account, registration), where a wrong call is expensive.
 *
 * Clef never writes prose, so callers synthesize their own `reason` from the
 * answered signals (`signalsReason`) and map the chosen option's probability to
 * a verdict confidence (`confidenceFromProbability`).
 *
 * Docs: https://developers.cloudflare.com/workers-ai/models/clef/
 */

export const CLEF_FLASH = "@cf/cloudflare/clef-flash" as const;
export const CLEF = "@cf/cloudflare/clef" as const;
export type ClefModel = typeof CLEF_FLASH | typeof CLEF;

export interface ClefNoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
}
export interface ClefChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}
export interface ClefScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}
export type ClefQuestion = ClefNoulQuestion | ClefChoiceQuestion | ClefScoreQuestion;

export interface ClefNoulAnswer {
  type: "noul";
  /** Probability the answer is yes (0..1). */
  noul: number;
}
export interface ClefChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface ClefScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}
export type ClefAnswer = ClefNoulAnswer | ClefChoiceAnswer | ClefScoreAnswer;
export type ClefAnswers = Record<string, ClefAnswer>;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Run a clef evaluation. Returns null when the model is unavailable, the call
 * fails or the response is malformed — callers then fall back to heuristics.
 *
 * The model service occasionally rejects a request transiently (cold start,
 * rate blip), so a failed attempt is retried once after a short pause: the
 * callers' timeouts (2.5 s screen / 6 s reasoning) leave room for two fast
 * clef calls.
 */
export async function runClef(
  ai: Ai,
  model: ClefModel,
  state: unknown,
  questions: Record<string, ClefQuestion>
): Promise<ClefAnswers | null> {
  const attempt = async (): Promise<ClefAnswers | null> => {
    try {
      const result = (await ai.run(model as Parameters<Ai["run"]>[0], {
        model: model === CLEF_FLASH ? "clef-flash" : "clef",
        state,
        questions,
      } as Parameters<Ai["run"]>[1])) as { answers?: unknown } | null;
      const answers = result?.answers;
      if (!answers || typeof answers !== "object") return null;
      return answers as ClefAnswers;
    } catch {
      return null;
    }
  };

  const first = await attempt();
  if (first) return first;
  await new Promise((resolve) => setTimeout(resolve, 250));
  return attempt();
}

/** Probability of a `noul` (yes/no) question, or null when absent/invalid. */
export function noulProbability(answers: ClefAnswers | null, id: string): number | null {
  const answer = answers?.[id];
  if (!answer || answer.type !== "noul") return null;
  const value = (answer as ClefNoulAnswer).noul;
  return typeof value === "number" && Number.isFinite(value) ? clamp01(value) : null;
}

/**
 * Chosen option of a `choice` question plus its probability. Falls back to the
 * answer's own confidence when the per-option map is missing the winner.
 */
export function pickChoice(
  answers: ClefAnswers | null,
  id: string
): { option: string; probability: number; confidence: number } | null {
  const answer = answers?.[id];
  if (!answer || answer.type !== "choice") return null;
  const choice = answer as ClefChoiceAnswer;
  if (typeof choice.choice !== "string" || !choice.choice) return null;
  const fromMap = choice.probabilities?.[choice.choice];
  const probability = typeof fromMap === "number" && Number.isFinite(fromMap)
    ? clamp01(fromMap)
    : clamp01(typeof choice.confidence === "number" ? choice.confidence : 0);
  const confidence = typeof choice.confidence === "number" && Number.isFinite(choice.confidence)
    ? clamp01(choice.confidence)
    : probability;
  return { option: choice.choice, probability, confidence };
}

/** Per-option probabilities of a `choice` question (empty when absent). */
export function choiceProbabilities(answers: ClefAnswers | null, id: string): Record<string, number> {
  const answer = answers?.[id];
  if (!answer || answer.type !== "choice") return {};
  const probabilities = (answer as ClefChoiceAnswer).probabilities;
  if (!probabilities || typeof probabilities !== "object") return {};
  const out: Record<string, number> = {};
  for (const [option, value] of Object.entries(probabilities)) {
    if (typeof value === "number" && Number.isFinite(value)) out[option] = clamp01(value);
  }
  return out;
}

/**
 * Human-readable reason synthesized from the answered yes/no signals, e.g.
 * `"spam (92%), estafa (78%)"` (labels are the instance language, Spanish).
 * Returns null when no signal reaches the threshold — callers then use a
 * generic per-action phrase.
 */
export function signalsReason(
  answers: ClefAnswers | null,
  labels: Record<string, string>,
  opts: { threshold?: number; max?: number } = {}
): string | null {
  const threshold = opts.threshold ?? 0.5;
  const max = opts.max ?? 3;
  const signals = Object.entries(labels)
    .map(([id, label]) => ({ label, probability: noulProbability(answers, id) ?? 0 }))
    .filter((signal) => signal.probability >= threshold)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, max);
  if (signals.length === 0) return null;
  return signals.map((signal) => `${signal.label} (${Math.round(signal.probability * 100)}%)`).join(", ");
}

/** Map the chosen option's probability to the Guardian's verdict confidence. */
export function confidenceFromProbability(probability: number): "low" | "medium" | "high" {
  if (probability >= 0.7) return "high";
  if (probability >= 0.45) return "medium";
  return "low";
}
