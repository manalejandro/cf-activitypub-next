// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { createECDH, generateKeyPairSync } from "node:crypto";
import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import type { LocalNotification } from "@/lib/types";

const dbMocks = vi.hoisted(() => ({ getPushSubscription: vi.fn() }));

vi.mock("@/lib/db", () => ({ getPushSubscription: dbMocks.getPushSubscription }));

import { importVapidPrivateKey, encryptPushNotification, deliverPushNotification, pushPresenceKey } from "@/lib/push";

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

function fromBase64url(s: string): Uint8Array {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
}

describe("web push aes128gcm encryption", () => {
  it("matches the RFC 8291 Appendix A test vectors", async () => {
    // Inputs from RFC 8291 Section 5 / Appendix A.
    const payload = fromBase64url("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24");
    const authSecret = fromBase64url("BTBZMqHH6r4Tts7J_aSIgg");
    const uaPublicRaw = fromBase64url(
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"
    );
    const asPublicRaw = fromBase64url(
      "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
    );
    const asPrivateRaw = fromBase64url("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw");
    const salt = fromBase64url("DGv6ra1nlYgDCS1FRnbzlw");
    const expected = fromBase64url(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
      "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
      "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
    );

    const asPrivateKey = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        d: base64url(asPrivateRaw),
        x: base64url(asPublicRaw.slice(1, 33)),
        y: base64url(asPublicRaw.slice(33, 65)),
      },
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"]
    );

    const body = await encryptPushNotification(payload, {
      uaPublicRaw,
      authSecret,
      asPublicRaw,
      asPrivateKey,
      salt,
    });

    expect(body.length).toBe(144);
    expect(base64url(body)).toBe(base64url(expected));
  });
});

describe("push presence", () => {
  it("hashes the subscription endpoint into the KV key", async () => {
    const a = await pushPresenceKey("a1", "https://push.example/ep1");
    const b = await pushPresenceKey("a1", "https://push.example/ep2");
    expect(a).not.toBe(b);
    expect(await pushPresenceKey("a1", "https://push.example/ep1")).toBe(a);
    expect(a).not.toContain("push.example");
    expect(a.startsWith("push:presence:a1:")).toBe(true);
  });

  it("skips delivery while the focused tab is present", async () => {
    dbMocks.getPushSubscription.mockResolvedValue({
      id: "s1", actorId: "a1", endpoint: "https://push.example/ep1",
      p256dhKey: "x", authKey: "y", standard: true, policy: "all",
      alerts: "{}", serverKey: "", sound: false, createdAt: "", updatedAt: "",
    });
    const get = vi.fn().mockResolvedValue("1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const notif = {
      id: "n1", type: "mention", targetAccountId: "a1", accountId: "b1", objectId: null,
    } as unknown as LocalNotification;
    await deliverPushNotification(
      {} as D1Database,
      { get } as unknown as KVNamespace,
      "pub", "priv", "mailto:x", notif
    );

    expect(get).toHaveBeenCalledWith(await pushPresenceKey("a1", "https://push.example/ep1"));
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
