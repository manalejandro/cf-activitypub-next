import type { D1Database } from "@cloudflare/workers-types";
import { getPushSubscription } from "@/lib/db";
import type { LocalNotification } from "@/lib/types";
import en from "@/lib/locales/en.json";
import es from "@/lib/locales/es.json";
import fr from "@/lib/locales/fr.json";
import de from "@/lib/locales/de.json";
import it from "@/lib/locales/it.json";
import ja from "@/lib/locales/ja.json";
import ko from "@/lib/locales/ko.json";
import pt from "@/lib/locales/pt.json";
import ru from "@/lib/locales/ru.json";
import zhHans from "@/lib/locales/zh-Hans.json";

/** Server-side locale dictionaries for the notification titles. */
const LOCALE_DICTS: Record<string, Record<string, string>> = {
  en: en as unknown as Record<string, string>,
  es: es as unknown as Record<string, string>,
  fr: fr as unknown as Record<string, string>,
  de: de as unknown as Record<string, string>,
  it: it as unknown as Record<string, string>,
  ja: ja as unknown as Record<string, string>,
  ko: ko as unknown as Record<string, string>,
  pt: pt as unknown as Record<string, string>,
  ru: ru as unknown as Record<string, string>,
  "zh-Hans": zhHans as unknown as Record<string, string>,
};

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDec(s: string): ArrayBuffer {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), c => c.charCodeAt(0)).buffer as ArrayBuffer;
}

function strBuf(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer as ArrayBuffer;
}

function ab2uint(ab: ArrayBuffer): Uint8Array {
  return new Uint8Array(ab);
}

function concat(...bs: ArrayBuffer[]): ArrayBuffer {
  let len = 0;
  for (const b of bs) len += b.byteLength;
  const r = new Uint8Array(len);
  let off = 0;
  for (const b of bs) { r.set(ab2uint(b), off); off += b.byteLength; }
  return r.buffer as ArrayBuffer;
}

async function hkdf(salt: ArrayBuffer, ikm: ArrayBuffer, info: ArrayBuffer, len: number): Promise<ArrayBuffer> {
  const prkK = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prk = await crypto.subtle.sign("HMAC", prkK, ikm);
  const rk = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const blocks: ArrayBuffer[] = [];
  let prev = new ArrayBuffer(0);
  for (let i = 1; blocks.length * 32 < len; i++) {
    const inp = concat(prev, info, new Uint8Array([i]).buffer as ArrayBuffer);
    prev = await crypto.subtle.sign("HMAC", rk, inp);
    blocks.push(prev);
  }
  return concat(...blocks).slice(0, len);
}

function notifTitle(dict: Record<string, string>, type: string): string {
  const key = `push_notif_${type}`;
  return dict[key] ?? dict.push_notif_default ?? "New notification";
}

/** Strip HTML tags and truncate to a short preview for the notification body. */
function snippet(html: string | null | undefined, max = 120): string {
  if (!html) return "";
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const TYPE_MAP: Record<string, string> = {
  mention: "mention", follow: "follow", follow_request: "follow_request",
  favourite: "favourite", reblog: "reblog", poll: "poll", update: "update",
  direct: "direct", encrypted: "encrypted",
};

export async function deliverPushNotification(
  db: D1Database,
  vapidPub: string,
  vapidPriv: string,
  vapidEmail: string,
  notif: LocalNotification,
): Promise<void> {
  const sub = await getPushSubscription(db, notif.targetAccountId);
  if (!sub) return;

  let alerts: Record<string, boolean> = {};
  try { alerts = JSON.parse(sub.alerts); } catch {}
  const ak = TYPE_MAP[notif.type];
  if (ak && alerts[ak] === false) return;
  if (sub.policy === "none") return;

  // Build a short body: the triggering account + (for content notifications) a
  // preview of the object. The title comes from the i18n dictionaries in the
  // user's stored UI locale (ui:locale preference), defaulting to English.
  const [actorRow, objectRow, localeRow] = await Promise.all([
    db.prepare("SELECT username, domain FROM actors WHERE id = ?").bind(notif.accountId).first<{ username: string; domain: string }>(),
    notif.objectId
      ? db.prepare("SELECT content FROM objects WHERE id = ?").bind(notif.objectId).first<{ content: string | null }>()
      : Promise.resolve(null),
    db.prepare("SELECT value FROM preferences WHERE actor_id = ? AND key = 'ui:locale'").bind(notif.targetAccountId).first<{ value: string }>(),
  ]);
  const dict = LOCALE_DICTS[localeRow?.value ?? "en"] ?? en;
  const who = actorRow ? (actorRow.domain ? `@${actorRow.username}@${actorRow.domain}` : `@${actorRow.username}`) : "";
  const preview = snippet(objectRow?.content ?? null);
  const bodyText = preview ? `${who ? `${who} · ` : ""}${preview}` : who;

  const payload = strBuf(JSON.stringify({
    title: notifTitle(dict, notif.type),
    body: bodyText,
    icon: "/logo.svg",
    badge: "/logo.svg",
    tag: `notif-${notif.id}`,
    sound: Boolean(sub.sound),
    data: { type: notif.type, account_id: notif.accountId, notification_id: notif.id, object_id: notif.objectId },
  }));

  const payloadU8 = new Uint8Array(payload);

  // Import VAPID private key for ECDSA JWT signing
  const vapidKey = await importVapidPrivateKey(vapidPriv);

  // Generate ephemeral ECDH key pair for encryption
  const ecdhKey = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const serverPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", ecdhKey.publicKey) as ArrayBuffer);

  const body = await encryptPushNotification(payloadU8, {
    uaPublicRaw: new Uint8Array(b64urlDec(sub.p256dhKey)),
    authSecret: new Uint8Array(b64urlDec(sub.authKey)),
    asPublicRaw: serverPubRaw,
    asPrivateKey: ecdhKey.privateKey,
    salt: crypto.getRandomValues(new Uint8Array(16)),
  });

  const origin = new URL(sub.endpoint).origin;
  const jwt = await vapidJwt(vapidKey, origin, vapidEmail);

  const resp = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      TTL: "86400",
      // RFC 8292 VAPID authentication scheme.
      Authorization: `vapid t=${jwt}, k=${vapidPub}`,
    },
    body: body as BodyInit,
  });

  if (resp.status === 410 || resp.status === 404) {
    await db.prepare("DELETE FROM push_subscriptions WHERE actor_id = ?").bind(notif.targetAccountId).run();
  } else if (!resp.ok) {
    // A 400/401 from the push service usually means the VAPID keys don't match
    // or the aes128gcm record is malformed — surface it in the logs instead of
    // failing silently (the notification would just never arrive).
    console.warn(`[push] delivery rejected by push service: HTTP ${resp.status} for ${sub.endpoint.slice(0, 60)}…`);
  }
}

export interface WebPushEncryptionInputs {
  /** User agent ECDH public key, uncompressed (65 bytes). */
  uaPublicRaw: Uint8Array;
  /** 16-byte subscription auth secret. */
  authSecret: Uint8Array;
  /** Application server (ephemeral) ECDH public key, uncompressed (65 bytes). */
  asPublicRaw: Uint8Array;
  /** Application server (ephemeral) ECDH private key. */
  asPrivateKey: CryptoKey;
  /** 16-byte random salt. */
  salt: Uint8Array;
}

/**
 * Encrypt a Web Push payload as a single RFC 8188 `aes128gcm` record with the
 * RFC 8291 key derivation. Exported so the test suite can assert the exact
 * output against the RFC 8291 Appendix A vectors.
 */
export async function encryptPushNotification(
  payload: Uint8Array,
  inputs: WebPushEncryptionInputs
): Promise<Uint8Array> {
  const clientPub = await crypto.subtle.importKey(
    "raw",
    ab(inputs.uaPublicRaw),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: clientPub },
    inputs.asPrivateKey,
    256
  ) as ArrayBuffer;

  // RFC 8291 §3.3: IKM = HKDF(auth_secret, ecdh_secret,
  //   "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const ikm = await hkdf(
    ab(inputs.authSecret),
    sharedSecret,
    concat(strBuf("WebPush: info\0"), ab(inputs.uaPublicRaw), ab(inputs.asPublicRaw)),
    32
  );

  // RFC 8188 §2.2: the salt is the HKDF salt; the info is the label only.
  const cek = await hkdf(ab(inputs.salt), ikm, strBuf("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ab(inputs.salt), ikm, strBuf("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  // RFC 8188: the single (last) record is data || 0x02 padding delimiter.
  const plaintext = concat(ab(payload), new Uint8Array([0x02]).buffer as ArrayBuffer);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: new Uint8Array(nonce), additionalData: new ArrayBuffer(0), tagLength: 128 },
    aesKey,
    plaintext
  );

  // Header: salt(16) || rs(4, 4096) || idlen(1) || keyid(as_public) || ciphertext.
  const rs = new Uint8Array([0x00, 0x00, 0x10, 0x00]);
  return new Uint8Array(concat(
    ab(inputs.salt),
    rs.buffer as ArrayBuffer,
    new Uint8Array([inputs.asPublicRaw.byteLength]).buffer as ArrayBuffer,
    ab(inputs.asPublicRaw),
    encrypted
  ));
}

/** Copy a Uint8Array view into a standalone ArrayBuffer. */
function ab(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function deliverPushSafe(
  db: D1Database,
  vapidPub: string,
  vapidPriv: string,
  vapidEmail: string,
  notif: LocalNotification,
): Promise<void> {
  try {
    await deliverPushNotification(db, vapidPub, vapidPriv, vapidEmail, notif);
  } catch (err) {
    // Push delivery failures are non-critical, but log them so a broken VAPID
    // config / encryption bug is visible in the worker logs.
    console.warn("[push] delivery failed", err instanceof Error ? err.message : err);
  }
}

// ── VAPID JWT ──

/**
 * Import the VAPID private key as an ECDSA P-256 signing key.
 *
 * Accepts the two formats found in the wild:
 *  - a PKCS8 PEM (`-----BEGIN PRIVATE KEY-----`), imported verbatim;
 *  - the Web Push standard: the raw 32-byte P-256 scalar, base64url (or base64)
 *    encoded — wrapped into a PKCS8 PrivateKeyInfo.
 */
export async function importVapidPrivateKey(vapidPriv: string): Promise<CryptoKey> {
  const trimmed = vapidPriv.trim();
  if (!trimmed) throw new Error("VAPID_PRIVATE_KEY is empty");

  if (trimmed.includes("-----BEGIN")) {
    const b64 = trimmed.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
    const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer as ArrayBuffer;
    return crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  }

  const raw = ab2uint(b64urlDec(trimmed));
  if (raw.byteLength !== 32) {
    throw new Error(`VAPID_PRIVATE_KEY must be a 32-byte P-256 key (got ${raw.byteLength} bytes)`);
  }
  return crypto.subtle.importKey("pkcs8", buildPkcs8(raw), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function vapidJwt(key: CryptoKey, aud: string, sub: string): Promise<string> {
  const h = b64url(strBuf(JSON.stringify({ alg: "ES256", typ: "JWT" })));
  const now = Math.floor(Date.now() / 1000);
  const p = b64url(strBuf(JSON.stringify({ aud, exp: now + 43200, sub })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, strBuf(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

// ── DER encoding helpers ──

function buildPkcs8(rawPriv: Uint8Array): ArrayBuffer {
  // PrivateKeyInfo ::= SEQUENCE {
  //   version INTEGER 0,
  //   privateKeyAlgorithm SEQUENCE { id-ecPublicKey, prime256v1 },
  //   privateKey OCTET STRING (ECPrivateKey)
  // }
  // ECPrivateKey ::= SEQUENCE { version INTEGER 1, privateKey OCTET STRING }
  const privBytes = rawPriv.buffer.slice(
    rawPriv.byteOffset,
    rawPriv.byteOffset + rawPriv.byteLength
  ) as ArrayBuffer;
  const ecPrivateKey = derSeq(concat(
    derInt(new Uint8Array([0x01]).buffer as ArrayBuffer),
    derOctet(privBytes),
  ));
  return derSeq(concat(
    derInt(new Uint8Array([0x00]).buffer as ArrayBuffer),
    derSeq(concat(
      // id-ecPublicKey: 1.2.840.10045.2.1
      derOid(new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]).buffer as ArrayBuffer),
      // prime256v1: 1.2.840.10045.3.1.7
      derOid(new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]).buffer as ArrayBuffer),
    )),
    derOctet(ecPrivateKey),
  ));
}

function derSeq(contents: ArrayBuffer): ArrayBuffer {
  return derTag(0x30, contents);
}

function derInt(val: ArrayBuffer): ArrayBuffer {
  return derTag(0x02, val);
}

function derOid(val: ArrayBuffer): ArrayBuffer {
  return derTag(0x06, val);
}

function derOctet(val: ArrayBuffer): ArrayBuffer {
  return derTag(0x04, val);
}

function derTag(tag: number, contents: ArrayBuffer): ArrayBuffer {
  const c = new Uint8Array(contents);
  let len: number[];
  if (c.length < 128) {
    len = [c.length];
  } else {
    const hex = c.length.toString(16);
    const n = Math.ceil(hex.length / 2);
    len = [0x80 | n];
    for (let i = 0; i < n; i++) len.push(parseInt(hex.substr(i * 2, 2), 16));
  }
  return concat(new Uint8Array([tag, ...len]).buffer as ArrayBuffer, contents);
}