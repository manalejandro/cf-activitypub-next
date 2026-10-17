/**
 * Workers-project setup.
 *
 * The AI and Vectorize bindings have no local simulator — Miniflare only warns
 * about them — so any test that reaches the Guardian's vector memory would make
 * a real embedding call and log an uncaught binding rejection. The memory is
 * mocked globally here: its behaviour is covered by `lib/__tests__/vectors.test.ts`
 * and `lib/__tests__/learn.test.ts` in the unit project, and a test file that
 * needs different behaviour still overrides this with its own `vi.mock`.
 */

import { vi } from "vitest";

const memory = vi.hoisted(() => ({
  rememberAbuse: async () => false,
  findSimilarAbuse: async () => [] as { id: string; kind: string; action: string; score: number }[],
  vectorPreScreen: async () => ({ autoAction: null, flagged: false, best: null, precedent: null }),
  learnFromSuspension: async () => null,
  forgetSuspension: async () => false,
}));

// The alias and the relative specifier resolve to the same file but are not
// interchangeable for the mock registry under the Cloudflare plugin's
// bundling: `lib/moderation/learn.ts` imports `./vectors`, the routes use `@/`.
vi.mock("../lib/moderation/vectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/moderation/vectors")>()),
  rememberAbuse: memory.rememberAbuse,
  findSimilarAbuse: memory.findSimilarAbuse,
  vectorPreScreen: memory.vectorPreScreen,
}));
vi.mock("@/lib/moderation/vectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/moderation/vectors")>()),
  rememberAbuse: memory.rememberAbuse,
  findSimilarAbuse: memory.findSimilarAbuse,
  vectorPreScreen: memory.vectorPreScreen,
}));

// `lib/moderation/learn.ts` is what touches the binding on every suspension
// (and even reading `env.VECTORIZE` raises the stub's rejection), so the module
// is mocked for both specifiers as well.
vi.mock("../lib/moderation/learn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/moderation/learn")>()),
  learnFromSuspension: memory.learnFromSuspension,
  forgetSuspension: memory.forgetSuspension,
}));
vi.mock("@/lib/moderation/learn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/moderation/learn")>()),
  learnFromSuspension: memory.learnFromSuspension,
  forgetSuspension: memory.forgetSuspension,
}));
