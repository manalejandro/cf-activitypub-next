// @vitest-environment node
import { describe, it, expect } from "vitest";
import { generateKeyPair, signRequest, verifySignature } from "@/lib/activitypub/security";
import { validateOutboundUrl } from "@/lib/activitypub/federation";

const TARGET = "https://remote.example/inbox";
const KEY_ID = "https://local.example/users/alice#main-key";
const BODY = JSON.stringify({ type: "Create", actor: "https://local.example/users/alice" });

function lower(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}

/** Signed headers plus the Host header the HTTP layer would add. */
async function signedHeaders(privateKeyPem: string): Promise<Record<string, string>> {
  return lower({ host: "remote.example", ...(await signRequest("POST", TARGET, BODY, privateKeyPem, KEY_ID)) });
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  return Uint8Array.from(Buffer.from(b64, "base64")).buffer;
}

async function sha256Base64(data: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Buffer.from(new Uint8Array(hash)).toString("base64");
}

describe("HTTP signature verification", () => {
  it("accepts a valid signed request with digest in the signed headers", async () => {
    const { publicKeyPem, privateKeyPem } = await generateKeyPair();
    const headers = await signedHeaders(privateKeyPem);
    expect(await verifySignature("POST", TARGET, headers, publicKeyPem, BODY)).toBe(true);
  });

  it("rejects a tampered body even when the digest header matches the original", async () => {
    const { publicKeyPem, privateKeyPem } = await generateKeyPair();
    const headers = await signedHeaders(privateKeyPem);
    expect(await verifySignature("POST", TARGET, headers, publicKeyPem, BODY + " ")).toBe(false);
  });

  it("rejects a signature whose signed-headers list omits digest", async () => {
    const { publicKeyPem, privateKeyPem } = await generateKeyPair();
    const date = new Date().toUTCString();
    const signingString = [
      "(request-target): post /inbox",
      "host: remote.example",
      `date: ${date}`,
    ].join("\n");
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pemToDer(privateKeyPem),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signatureBytes = await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      new TextEncoder().encode(signingString)
    );
    const signature = Buffer.from(new Uint8Array(signatureBytes)).toString("base64");
    const headers = {
      host: "remote.example",
      date,
      digest: `SHA-256=${await sha256Base64(BODY)}`,
      signature: `keyId="${KEY_ID}",algorithm="rsa-sha256",headers="(request-target) host date",signature="${signature}"`,
    };
    expect(await verifySignature("POST", TARGET, headers, publicKeyPem, BODY)).toBe(false);
  });

  it("rejects unsupported signature algorithms", async () => {
    const { publicKeyPem, privateKeyPem } = await generateKeyPair();
    const headers = await signedHeaders(privateKeyPem);
    headers.signature = headers.signature.replace('algorithm="rsa-sha256"', 'algorithm="ecdsa-sha256"');
    expect(await verifySignature("POST", TARGET, headers, publicKeyPem, BODY)).toBe(false);
  });
});

describe("validateOutboundUrl", () => {
  it.each([
    "http://mastodon.social/users/x",
    "https://localhost/x",
    "https://foo.internal/x",
    "https://foo.home.arpa/x",
    "https://127.0.0.1/x",
    "https://10.1.2.3/x",
    "https://192.168.1.10/x",
    "https://172.16.0.1/x",
    "https://169.254.169.254/latest/meta-data",
    "https://100.64.0.1/x",
    "https://224.0.0.1/x",
    "https://[::1]/x",
    "https://[::ffff:127.0.0.1]/x",
  ])("rejects %s", (url) => {
    expect(validateOutboundUrl(url).valid).toBe(false);
  });

  it.each([
    "https://mastodon.social/users/alice",
    "https://pixelfed.social/users/fotopsia",
    "https://example.com/inbox",
  ])("accepts %s", (url) => {
    expect(validateOutboundUrl(url).valid).toBe(true);
  });
});
