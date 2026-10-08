import { describe, it, expect, beforeEach } from "vitest";
import { parseClefSafety } from "@/lib/moderation/classifier";
import type { ClefAnswers } from "@/lib/moderation/clef";
import {
  stripHtml,
  countUrls,
  contentHash,
  computeContentSignals,
  computeAccountSignals,
  computeRegistrationSignals,
  hasAbuseSignals,
} from "@/lib/moderation/heuristics";
import { chargeGlobalAI, AI_UNITS_REASON } from "@/lib/moderation/budget";

describe("chargeGlobalAI", () => {
  const store = new Map<string, string>();

  const fakeKV = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
  } as unknown as KVNamespace;

  beforeEach(() => store.clear());

  it("allows calls while under the daily budget", async () => {
    const env = { KV: fakeKV, AI_DAILY_BUDGET: "100" };
    expect(await chargeGlobalAI(env, AI_UNITS_REASON)).toBe(true);
    expect(await chargeGlobalAI(env, AI_UNITS_REASON)).toBe(true);
  });

  it("refuses once the day's budget is exhausted", async () => {
    const env = { KV: fakeKV, AI_DAILY_BUDGET: "100" };
    await chargeGlobalAI(env, 100);
    expect(await chargeGlobalAI(env, 1)).toBe(false);
  });

  it("is unlimited when the budget is unset or zero", async () => {
    const env = { KV: fakeKV } as { KV: KVNamespace; AI_DAILY_BUDGET?: string };
    expect(await chargeGlobalAI(env, 9999)).toBe(true);
    expect(await chargeGlobalAI({ KV: fakeKV, AI_DAILY_BUDGET: "0" }, 9999)).toBe(true);
  });
});

describe("parseClefSafety", () => {
  function answers(unsafe: number, probabilities: Record<string, number> = {}): ClefAnswers {
    return {
      unsafe: { type: "noul", noul: unsafe },
      category: { type: "choice", choice: "none", probabilities, confidence: 0.9 },
    };
  }

  it("treats a low unsafe probability as safe", () => {
    const v = parseClefSafety(answers(0.2, { none: 0.9, S1: 0.05 }));
    expect(v?.safe).toBe(true);
    expect(v?.categories).toEqual([]);
  });

  it("reports every category above the threshold when unsafe", () => {
    const v = parseClefSafety(answers(0.9, { none: 0.1, S10: 0.7, S2: 0.4, S1: 0.05 }));
    expect(v?.safe).toBe(false);
    expect(v?.categories).toEqual(["S10: Hate", "S2: Non-Violent Crimes"]);
  });

  it("falls back to the model's top category when none clears the threshold", () => {
    const v = parseClefSafety(answers(0.8, { none: 0.6, S12: 0.2, S11: 0.15 }));
    expect(v?.safe).toBe(false);
    expect(v?.categories).toEqual(["S12: Sexual Content"]);
  });

  it("returns null when the model did not answer", () => {
    expect(parseClefSafety(null)).toBeNull();
    expect(parseClefSafety({} as ClefAnswers)).toBeNull();
  });
});

describe("stripHtml", () => {
  it("removes tags and normalizes whitespace", () => {
    expect(stripHtml("<p>Hola <b>mundo</b></p>")).toBe("Hola mundo");
    expect(stripHtml("a<br> b &amp; c")).toBe("a b & c");
  });
});

describe("countUrls", () => {
  it("counts URLs in plain text", () => {
    expect(countUrls("https://a.com https://b.com hola")).toBe(2);
    expect(countUrls("sin enlaces")).toBe(0);
  });
});

describe("contentHash", () => {
  it("is stable and case/space-insensitive", () => {
    expect(contentHash("Buy Now!!!")).toBe(contentHash("  buy now!!! "));
    expect(contentHash("buy")).not.toBe(contentHash("sell"));
  });
});

describe("computeContentSignals", () => {
  it("flags a link-only message", () => {
    const s = computeContentSignals('<p><a href="https://x.com">https://x.com</a> <a href="https://y.com">https://y.com</a></p>');
    expect(s.flags).toContain("texto_casi_solo_enlaces");
  });

  it("flags all-caps shouting", () => {
    const s = computeContentSignals("<p>ESTE ES UN GRITO MUY FUERTE PARA LLAMAR LA ATENCION</p>");
    expect(s.flags).toContain("mayusculas_excesivas");
  });

  it("flags excessive emoji", () => {
    const s = computeContentSignals("<p>🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉 genial</p>");
    expect(s.flags).toContain("emoji_excesivo");
  });

  it("flags scam patterns", () => {
    const s = computeContentSignals("<p>gana dinero rápido clic aquí</p>");
    expect(s.flags).toContain("patron_estafa");
  });

  it("returns no flags for benign content", () => {
    const s = computeContentSignals("<p>Hola, hoy hace buen día en la ciudad.</p>");
    expect(s.flags).toEqual([]);
  });
});

describe("computeAccountSignals", () => {
  it("flags young mass-follow accounts", () => {
    const s = computeAccountSignals({
      statusesCount: 0,
      followersCount: 0,
      followingCount: 120,
      ageDays: 0.5,
      isBot: false,
      postsLastHour: 0,
      postsLastDay: 0,
      linkStatuses: 0,
      followsLastHour: 40,
    });
    expect(s.flags).toContain("cuenta_joven_masivo_follow");
    expect(s.flags).toContain("burst_seguimiento");
  });

  it("flags high posting volume", () => {
    const s = computeAccountSignals({
      statusesCount: 100,
      followersCount: 1,
      followingCount: 0,
      ageDays: 1,
      isBot: false,
      postsLastHour: 20,
      postsLastDay: 80,
      linkStatuses: 90,
      followsLastHour: 0,
    });
    expect(s.flags).toContain("inundacion_hora");
    expect(s.flags).toContain("mayoria_enlaces");
  });

  it("no flags for normal accounts", () => {
    const s = computeAccountSignals({
      statusesCount: 10,
      followersCount: 5,
      followingCount: 4,
      ageDays: 30,
      isBot: false,
      postsLastHour: 0,
      postsLastDay: 1,
      linkStatuses: 0,
      followsLastHour: 0,
    });
    expect(s.flags).toEqual([]);
  });
});

describe("hasAbuseSignals", () => {
  it("treats pure volume signals as normal (no AI review)", () => {
    for (const flag of ["alta_tasa_publicacion", "inundacion_hora", "inundacion_dia", "cuenta_vacia"]) {
      expect(hasAbuseSignals({ flags: [flag] })).toBe(false);
    }
  });

  it("no signals → no AI review", () => {
    expect(hasAbuseSignals({ flags: [] })).toBe(false);
  });

  it("behavior/content flags justify an AI review", () => {
    for (const flag of ["cuenta_joven_masivo_follow", "burst_seguimiento", "mayoria_enlaces", "bot_spam_enlaces"]) {
      expect(hasAbuseSignals({ flags: [flag] })).toBe(true);
    }
  });

  it("mixed signals with at least one abuse flag → review", () => {
    expect(hasAbuseSignals({ flags: ["alta_tasa_publicacion", "burst_seguimiento"] })).toBe(true);
  });
});

describe("computeRegistrationSignals", () => {
  it("flags a suspicious IP", () => {
    const s = computeRegistrationSignals({ username: "maria", email: "maria@example.com", ipSuspicious: true });
    expect(s.flags).toContain("ip_sospechosa");
  });

  it("flags a disposable email domain", () => {
    const s = computeRegistrationSignals({ username: "juan", email: "juan@guerrillamail.com", ipSuspicious: false });
    expect(s.flags).toContain("email_desechable");
  });

  it("flags a spammy username", () => {
    const s = computeRegistrationSignals({ username: "gana-dinero-facil", email: "a@example.com", ipSuspicious: false });
    expect(s.flags).toContain("username_sospechoso");
  });

  it("returns no flags for a clean registration", () => {
    const s = computeRegistrationSignals({ username: "ana", email: "ana@example.com", ipSuspicious: false });
    expect(s.flags).toEqual([]);
  });
});
