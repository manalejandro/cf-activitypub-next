// @vitest-environment node
import { describe, it, expect } from "vitest";
import { createECDH, generateKeyPairSync } from "node:crypto";
import { importVapidPrivateKey } from "@/lib/push";

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function verifyWith(pubRaw: Uint8Array, signature: ArrayBuffer, data: ArrayBuffer): Promise<boolean> {
  const pubKey = await crypto.subtle.importKey(
    "raw",
    pubRaw.buffer.slice(pubRaw.byteOffset, pubRaw.byteOffset + pubRaw.byteLength) as ArrayBuffer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pubKey, signature, data);
}

describe("VAPID private key import", () => {
  it("imports a raw 32-byte base64url key and signs verifiably", async () => {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const rawPriv = ecdh.getPrivateKey();
    const rawPub = ecdh.getPublicKey();
    expect(rawPriv.length).toBe(32);

    const key = await importVapidPrivateKey(base64url(rawPriv));
    const data = new TextEncoder().encode("vapid-test").buffer as ArrayBuffer;
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data);

    expect(await verifyWith(rawPub, signature, data)).toBe(true);
  });

  it("imports a PKCS8 PEM key", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    const key = await importVapidPrivateKey(pem);
    const data = new TextEncoder().encode("vapid-pem").buffer as ArrayBuffer;
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data);
    expect(signature.byteLength).toBe(64);
  });

  it("rejects a key that is not 32 bytes", async () => {
    const short = new Uint8Array(16).fill(1);
    await expect(importVapidPrivateKey(base64url(short))).rejects.toThrow(/32-byte/);
    await expect(importVapidPrivateKey("")).rejects.toThrow(/empty/);
  });
});
