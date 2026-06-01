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
  publicKeyPem: string
): Promise<boolean> {
  const sigHeader = headers["signature"] || headers["Signature"];
  if (!sigHeader) return false;

  const parsed = parseSignatureHeader(sigHeader);
  if (!parsed) return false;

  const urlObj = new URL(url);
  const headerList = (parsed.headers || "(request-target) host date").split(" ");

  const headerMap: Record<string, string> = {
    "(request-target)": `${method.toLowerCase()} ${urlObj.pathname}${urlObj.search}`,
    ...Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
    ),
  };

  const signingString = headerList
    .map((h) => `${h}: ${headerMap[h] ?? ""}`)
    .join("\n");

  try {
    const publicKey = await importPublicKey(publicKeyPem);
    const signatureBytes = Uint8Array.from(atob(parsed.signature), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify(
      ALGORITHM,
      publicKey,
      signatureBytes,
      new TextEncoder().encode(signingString)
    );
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────
// Key ID extraction (exported for inbox routes)
// ─────────────────────────────────────────

/**
 * Extract the keyId value from the HTTP Signature header.
 * This identifies the actor that actually signed the request —
 * which may differ from the activity's `actor` field when the
 * request was relayed / forwarded by a different server.
 */
export function extractSigningKeyId(headers: Record<string, string>): string | null {
  const sigHeader = headers["signature"] || headers["Signature"];
  if (!sigHeader) return null;
  const parsed = parseSignatureHeader(sigHeader);
  return parsed?.keyId ?? null;
}

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

function parseSignatureHeader(header: string): Record<string, string> | null {
  const result: Record<string, string> = {};
  const regex = /(\w+)="([^"]+)"/g;
  let match;
  while ((match = regex.exec(header)) !== null) {
    result[match[1]] = match[2];
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
