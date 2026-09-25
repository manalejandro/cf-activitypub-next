/**
 * HTTP Signature implementation using the Web Crypto API.
 * Compatible with Cloudflare Workers (no Node.js crypto module required).
 */

const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

// ─────────────────────────────────────────
// Key generation
// ─────────────────────────────────────────

export async function generateKeyPair(): Promise<{ publicKeyPem: string; privateKeyPem: string }> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );

  const [publicDer, privateDer] = await Promise.all([
    crypto.subtle.exportKey("spki", keyPair.publicKey),
    crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
  ]);

  return {
    publicKeyPem: derToPem(publicDer, "PUBLIC KEY"),
    privateKeyPem: derToPem(privateDer, "PRIVATE KEY"),
  };
}

// ─────────────────────────────────────────
// Signing outgoing requests
// ─────────────────────────────────────────

export async function signRequest(
  method: string,
  url: string,
  body: string | null,
  privateKeyPem: string,
  keyId: string
): Promise<Record<string, string>> {
  const urlObj = new URL(url);
  const date = new Date().toUTCString();
  const digest = body
    ? `SHA-256=${await sha256Base64(body)}`
    : null;

  const headersToSign = ["(request-target)", "host", "date"];
  if (digest) headersToSign.push("digest");

  const headerMap: Record<string, string> = {
    "(request-target)": `${method.toLowerCase()} ${urlObj.pathname}${urlObj.search}`,
    host: urlObj.host,
    date,
    ...(digest ? { digest } : {}),
  };

  const signingString = headersToSign
    .map((h) => `${h}: ${headerMap[h]}`)
    .join("\n");

  const privateKey = await importPrivateKey(privateKeyPem);
  const signatureBytes = await crypto.subtle.sign(
    ALGORITHM,
    privateKey,
    new TextEncoder().encode(signingString)
  );
  const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBytes)));

  const signatureHeader = [
    `keyId="${keyId}"`,
    `algorithm="rsa-sha256"`,
    `headers="${headersToSign.join(" ")}"`,
    `signature="${signature}"`,
  ].join(",");

  return {
    Date: date,
    Signature: signatureHeader,
    ...(digest ? { Digest: digest } : {}),
  };
}

// ─────────────────────────────────────────
// Verifying incoming signatures
// ─────────────────────────────────────────

export async function verifySignature(
  method: string,
  url: string,
  headers: Record<string, string>,
  publicKeyPem: string,
  body?: string | null
): Promise<boolean> {
  const lower = lowerHeaders(headers);
  try {
    // Mastodon 4.7+ sends RFC 9421 HTTP Message Signatures (`Signature-Input`
    // + `Signature`) alongside or instead of draft-cavage signatures.
    if (lower["signature-input"]) {
      if (await verifyMessageSignature(method, url, lower, publicKeyPem, body)) return true;
      // Some senders attach both schemes; fall back to draft-cavage when the
      // same request also carries a `keyId` signature.
      return /keyId\s*=/i.test(lower["signature"] ?? "")
        ? verifyCavageSignature(method, url, lower, publicKeyPem, body)
        : false;
    }
    return verifyCavageSignature(method, url, lower, publicKeyPem, body);
  } catch {
    return false;
  }
}

const MAX_SIGNATURE_AGE_MS = 12 * 36e5;
const CLOCK_SKEW_MS = 36e5;

function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}

/** draft-cavage (http-signature) verification. */
async function verifyCavageSignature(
  method: string,
  url: string,
  headers: Record<string, string>,
  publicKeyPem: string,
  body?: string | null
): Promise<boolean> {
  const parsed = parseSignatureHeader(headers["signature"] ?? "");
  if (!parsed) return false;
  const keyId = parsed.keyId ?? parsed.keyid;
  const signature = parsed.signature;
  if (!keyId || !signature) return false;
  if (parsed.algorithm && !/^(rsa-sha256|hs2019)$/i.test(parsed.algorithm)) return false;

  const methodUpper = method.toUpperCase();
  const hasBody = body != null;
  const headerList = (parsed.headers || "date").toLowerCase().split(/\s+/).filter(Boolean);

  // Mastodon's signature strength rules, mirrored for interop: only the
  // request target OR the digest must be signed (not both), a POST needs the
  // digest and a GET needs the host.
  if (!headerList.includes("date") && !headerList.includes("(created)")) return false;
  if (!headerList.includes("(request-target)") && !headerList.includes("digest")) return false;
  if (methodUpper === "POST" && !headerList.includes("digest")) return false;
  if (methodUpper === "GET" && !headerList.includes("host")) return false;
  if (headerList.includes("(created)") && !parsed.created) return false;
  if (headerList.includes("(expires)") && !parsed.expires) return false;

  // Time window (Mastodon: 12h + 1h clock skew).
  if (parsed.created) {
    const createdMs = Number(parsed.created) * 1000;
    if (!Number.isFinite(createdMs) || Math.abs(Date.now() - createdMs) > MAX_SIGNATURE_AGE_MS + CLOCK_SKEW_MS) return false;
  } else {
    const dateMs = Date.parse(headers["date"] ?? "");
    if (!Number.isFinite(dateMs) || Math.abs(Date.now() - dateMs) > MAX_SIGNATURE_AGE_MS + CLOCK_SKEW_MS) return false;
  }
  if (parsed.expires) {
    const expiresMs = Number(parsed.expires) * 1000;
    if (Number.isFinite(expiresMs) && Date.now() > expiresMs + CLOCK_SKEW_MS) return false;
  }

  // Every header named in the signed-headers list must be present.
  for (const h of headerList) {
    if (h.startsWith("(")) continue;
    if (headers[h] == null) return false;
  }

  // A body must be cryptographically bound through the Digest header.
  if (hasBody && headerList.includes("digest")) {
    if (!(await digestHeaderMatches(headers["digest"] ?? "", body))) return false;
  }

  const urlObj = new URL(url);
  const build = (withQuery: boolean): string =>
    headerList
      .map((h) => {
        if (h === "(request-target)") {
          return `${h}: ${method.toLowerCase()} ${withQuery ? urlObj.pathname + urlObj.search : urlObj.pathname}`;
        }
        if (h === "(created)") return `${h}: ${parsed.created ?? ""}`;
        if (h === "(expires)") return `${h}: ${parsed.expires ?? ""}`;
        return `${h}: ${headers[h]}`;
      })
      .join("\n");

  if (await verifyRsa(publicKeyPem, signature, build(true))) return true;
  // Some senders (older Mastodon) wrongly omit the query string.
  return urlObj.search ? verifyRsa(publicKeyPem, signature, build(false)) : false;
}

/** RFC 9421 HTTP Message Signatures (`Signature-Input` + `Signature`). */
async function verifyMessageSignature(
  method: string,
  url: string,
  headers: Record<string, string>,
  publicKeyPem: string,
  body?: string | null
): Promise<boolean> {
  const parsed = parseSignatureInput(headers["signature-input"] ?? "");
  if (!parsed) return false;
  const signature = extractSignatureDictValue(headers["signature"] ?? "", parsed.label);
  if (!signature) return false;
  if (!parsed.params.keyid) return false;

  // Mastodon requires the `created` parameter; enforce its time window.
  if (!parsed.params.created) return false;
  const createdMs = Number(parsed.params.created) * 1000;
  if (!Number.isFinite(createdMs) || Math.abs(Date.now() - createdMs) > MAX_SIGNATURE_AGE_MS + CLOCK_SKEW_MS) return false;
  if (parsed.params.expires) {
    const expiresMs = Number(parsed.params.expires) * 1000;
    if (Number.isFinite(expiresMs) && Date.now() > expiresMs + CLOCK_SKEW_MS) return false;
  }

  const components = parsed.components;
  if (!components.includes("@method") || !components.includes("@target-uri")) return false;
  if (method.toUpperCase() === "POST" && !components.includes("content-digest")) return false;
  if (components.includes("content-digest")) {
    if (body == null || !(await contentDigestMatches(headers["content-digest"] ?? "", body))) return false;
  }

  const urlObj = new URL(url);
  const lines: string[] = [];
  for (const component of components) {
    switch (component) {
      case "@method":
        lines.push(`"@method": ${method.toUpperCase()}`);
        break;
      case "@target-uri":
        lines.push(`"@target-uri": ${url}`);
        break;
      case "@authority":
        lines.push(`"@authority": ${urlObj.host}`);
        break;
      case "@scheme":
        lines.push(`"@scheme": ${urlObj.protocol.replace(/:$/, "")}`);
        break;
      case "@path":
        lines.push(`"@path": ${urlObj.pathname}`);
        break;
      case "@query":
        lines.push(`"@query": ?${urlObj.search.replace(/^\?/, "")}`);
        break;
      case "@request-target":
        lines.push(`"@request-target": ${method.toLowerCase()} ${urlObj.pathname}${urlObj.search}`);
        break;
      default: {
        const value = headers[component.toLowerCase()];
        if (value == null) return false;
        lines.push(`"${component}": ${value}`);
      }
    }
  }
  lines.push(`"@signature-params": ${parsed.paramsString}`);
  const signingString = lines.join("\n");

  if (await verifyRsa(publicKeyPem, signature, signingString)) return true;
  // RSA-PSS (rsa-pss-sha512) is the other RSA option in RFC 9421.
  return verifyRsaPss512(publicKeyPem, signature, signingString);
}

async function verifyRsa(publicKeyPem: string, signatureB64: string, signingString: string): Promise<boolean> {
  try {
    const publicKey = await importPublicKey(publicKeyPem);
    const signatureBytes = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify(ALGORITHM, publicKey, signatureBytes, new TextEncoder().encode(signingString));
  } catch {
    return false;
  }
}

async function verifyRsaPss512(publicKeyPem: string, signatureB64: string, signingString: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("spki", pemToDer(publicKeyPem, "PUBLIC KEY"), { name: "RSA-PSS", hash: "SHA-512" }, false, ["verify"]);
    const signatureBytes = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify({ name: "RSA-PSS", saltLength: 64 }, key, signatureBytes, new TextEncoder().encode(signingString));
  } catch {
    return false;
  }
}

/** `Digest: SHA-256=base64[, …]` (several algorithms are tolerated). */
async function digestHeaderMatches(header: string, body: string): Promise<boolean> {
  const expected = await sha256Base64(body);
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim().toLowerCase() !== "sha-256") continue;
    return part.slice(eq + 1).trim() === expected;
  }
  return false;
}

/** RFC 9530 `Content-Digest: sha-256=:base64:` */
async function contentDigestMatches(header: string, body: string): Promise<boolean> {
  const expected = await sha256Base64(body);
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim().toLowerCase() !== "sha-256") continue;
    return part.slice(eq + 1).trim().replace(/^:|:$/g, "") === expected;
  }
  return false;
}

interface ParsedSignatureInput {
  label: string;
  components: string[];
  params: Record<string, string>;
  paramsString: string;
}

function parseSignatureInput(value: string): ParsedSignatureInput | null {
  const eq = value.indexOf("=");
  if (eq < 1) return null;
  const label = value.slice(0, eq).trim();
  const rest = value.slice(eq + 1).trim();
  const close = rest.indexOf(")");
  if (!rest.startsWith("(") || close < 0) return null;
  const components = [...rest.slice(1, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (components.length === 0) return null;
  // The exact member value (component list + parameters) is signed through
  // the `@signature-params` line, so it must be preserved verbatim.
  const paramsString = rest;
  const params: Record<string, string> = {};
  for (const m of paramsString.matchAll(/;\s*([A-Za-z0-9_-]+)\s*=\s*("[^"]*"|[^;]+)/g)) {
    params[m[1].toLowerCase()] = m[2].replace(/^"|"$/g, "").trim();
  }
  return { label, components, params, paramsString };
}

function extractSignatureDictValue(dict: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = dict.match(new RegExp(`(?:^|,)\\s*${escaped}\\s*=\\s*:([^:]+):`));
  return m ? m[1].trim() : null;
}

// ─────────────────────────────────────────
// Key ID extraction (exported for inbox routes)
// ─────────────────────────────────────────

/**
 * Extract the keyId value from the HTTP Signature header. Supports both
 * draft-cavage (`keyId="…"`) and RFC 9421 (`keyid="…"` in `Signature-Input`).
 * This identifies the actor that actually signed the request — which may
 * differ from the activity's `actor` field when the request was relayed.
 */
export function extractSigningKeyId(headers: Record<string, string>): string | null {
  const lower = lowerHeaders(headers);
  if (lower["signature-input"]) {
    const m = lower["signature-input"].match(/keyid\s*=\s*"([^"]+)"/i);
    return m ? m[1] : null;
  }
  const parsed = parseSignatureHeader(lower["signature"] ?? "");
  return parsed?.keyId ?? parsed?.keyid ?? null;
}

function parseSignatureHeader(header: string): Record<string, string> | null {
  const result: Record<string, string> = {};
  // Quoted values (keyId, headers, signature) plus unquoted parameters such as
  // the `created`/`expires` of hs2019 signatures.
  const regex = /([A-Za-z0-9_]+)\s*=\s*(?:"([^"]*)"|([^,;\s]+))/g;
  let match;
  while ((match = regex.exec(header)) !== null) {
    result[match[1]] = match[2] ?? match[3];
  }
  return Object.keys(result).length > 0 ? result : null;
}

async function sha256Base64(data: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const der = pemToDer(pem, "PRIVATE KEY");
  return crypto.subtle.importKey("pkcs8", der, ALGORITHM, false, ["sign"]);
}

async function importPublicKey(pem: string): Promise<CryptoKey> {
  const der = pemToDer(pem, "PUBLIC KEY");
  return crypto.subtle.importKey("spki", der, ALGORITHM, false, ["verify"]);
}

function pemToDer(pem: string, label: string): ArrayBuffer {
  const b64 = pem
    .replace(`-----BEGIN ${label}-----`, "")
    .replace(`-----END ${label}-----`, "")
    .replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function derToPem(der: ArrayBuffer, label: string): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}
