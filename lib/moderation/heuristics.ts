/**
 * Deterministic abuse signals — cheap, rule-based checks that complement the AI.
 * These never take final action on their own; they feed "flags" into the AI
 * prompts and the scheduled moderation cycle (so a spambot is caught even if
 * the LLM call fails or is unavailable).
 */

/** Strip HTML tags for analysis. */
export function stripHtml(html: string): string {
  return (html ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Count bare URLs in plain text. */
export function countUrls(text: string): number {
  const matches = text.match(/https?:\/\/[^\s<>]+/gi);
  return matches ? matches.length : 0;
}

/** Stable short hash of normalized text — used to detect repeated spam. */
export function contentHash(text: string): string {
  const normalized = stripHtml(text).toLowerCase().replace(/\s+/g, " ").trim();
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36);
}

export interface ContentSignals {
  text: string;
  links: number;
  emojiCount: number;
  isAllCaps: boolean;
  wordCount: number;
  flags: string[];
}

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;

/** Compute deterministic signals for a status's content. */
export function computeContentSignals(html: string): ContentSignals {
  const text = stripHtml(html);
  const links = countUrls(text);
  const emojiCount = (text.match(EMOJI_RE) ?? []).length;
  const words = text.split(/\s+/).filter(Boolean);
  const letters = text.replace(/[^a-zA-ZáéíóúüñÁÉÍÓÚÜÑ]/g, "");
  const isAllCaps = letters.length >= 15 && letters === letters.toUpperCase() && /[A-ZÁÉÍÓÚÜÑ]{15}/.test(letters);
  const flags: string[] = [];

  if (links >= 2 && words.length <= links + 3) flags.push("texto_casi_solo_enlaces");
  else if (links >= 2 && words.length <= 10) flags.push("muchos_enlaces");
  if (words.length <= 4 && links >= 1) flags.push("mensaje_corto_con_enlace");
  if (isAllCaps) flags.push("mayusculas_excesivas");
  if (emojiCount >= 8) flags.push("emoji_excesivo");
  if (/(telegram|whatsapp|casino|💸|🔥|gana dinero|hazte rico|hazte millonario|cryptocurrency|bitcoin|click aqui|clic aquí|click here|make money|get rich|free money|earn money|win a prize|sign up now|crypto giveaway|investment opportunity|work from home)/i.test(text)) {
    flags.push("patron_estafa");
  }

  return { text, links, emojiCount, isAllCaps, wordCount: words.length, flags };
}

export interface AccountSignals {
  flags: string[];
  linkRatio: number;
  postsLastHour: number;
  postsLastDay: number;
  followsLastHour: number;
}

/**
 * Compute per-account behavior signals. Accepts pre-queryable counters so the
 * scheduled cycle can batch the SQL and this stays testable in isolation.
 */
export function computeAccountSignals(input: {
  statusesCount: number;
  followersCount: number;
  followingCount: number;
  ageDays: number;
  isBot: boolean;
  postsLastHour: number;
  postsLastDay: number;
  linkStatuses: number;
  followsLastHour: number;
}): AccountSignals {
  const flags: string[] = [];
  const linkRatio = input.statusesCount > 0 ? input.linkStatuses / input.statusesCount : 0;

  if (input.ageDays < 2 && input.followingCount >= 50 && input.followersCount < 5) {
    flags.push("cuenta_joven_masivo_follow");
  }
  if (input.ageDays < 2 && input.statusesCount >= 50) {
    flags.push("alta_tasa_publicacion");
  }
  if (input.postsLastHour >= 20) flags.push("inundacion_hora");
  if (input.postsLastDay >= 100) flags.push("inundacion_dia");
  if (input.followsLastHour >= 30) flags.push("burst_seguimiento");
  if (linkRatio >= 0.8 && input.statusesCount >= 3) flags.push("mayoria_enlaces");
  if (input.isBot && linkRatio >= 0.5 && input.statusesCount >= 10) flags.push("bot_spam_enlaces");
  if (input.ageDays < 0.5 && input.statusesCount === 0 && input.followingCount === 0) flags.push("cuenta_vacia");

  return { flags, linkRatio, postsLastHour: input.postsLastHour, postsLastDay: input.postsLastDay, followsLastHour: input.followsLastHour };
}

/**
 * Volume-only account signals that are normal for busy (especially remote)
 * accounts and never justify an expensive AI review on their own.
 */
export const VOLUME_ONLY_ACCOUNT_FLAGS = new Set([
  "alta_tasa_publicacion",
  "inundacion_hora",
  "inundacion_dia",
  "cuenta_vacia",
]);

/** Whether account signals contain a concrete abuse signal worth an AI review. */
export function hasAbuseSignals(signals: Pick<AccountSignals, "flags">): boolean {
  return signals.flags.some((f) => !VOLUME_ONLY_ACCOUNT_FLAGS.has(f));
}

/** Suspicious-looking email domains for registration gating (heuristic). */
export const DISPOSABLE_EMAIL_HINTS = ["tempmail", "mailinator", "guerrillamail", "10minutemail", "throwaway", "yopmail", "sharklasers"];

export interface RegistrationSignals {
  flags: string[];
}

const SUSPICIOUS_USERNAME_RE =
  /(buy|free|earn|money|cash|crypto|bitcoin|eth|nft|win|prize|bet|casino|loan|hazte|gana|sigue|follow|telegram|whatsapp|vip|invest|bono|bonus|oferta|descuento|\d{6,})/i;

/**
 * Deterministic registration pre-screen. When these flags are present the
 * registration is suspicious enough to warrant a reasoning-model review;
 * otherwise the account is approved without spending AI neurons. A spammy
 * username or a disposable-email address alone is a strong enough signal to
 * escalate, because both are hallmarks of mass-created bot accounts.
 */
export function computeRegistrationSignals(input: {
  username: string;
  email: string;
  ipSuspicious: boolean;
  /** Another account (or a previous attempt) exists for the same mailbox. */
  canonicalVariant?: boolean;
}): RegistrationSignals {
  const flags: string[] = [];
  const emailDomain = input.email.split("@")[1]?.toLowerCase() ?? "";

  if (input.ipSuspicious) flags.push("ip_sospechosa");
  if (DISPOSABLE_EMAIL_HINTS.some((h) => emailDomain.includes(h))) flags.push("email_desechable");
  if (SUSPICIOUS_USERNAME_RE.test(input.username)) flags.push("username_sospechoso");
  // `user+tag@domain` / dotted variants of a mailbox that already registered
  // (or is being farmed) are the signature of bulk account creation.
  if (input.canonicalVariant) flags.push("variante_de_correo");

  return { flags };
}
