import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

const remote = vi.hoisted(() => ({
  fetchAndCacheRemoteActor: vi.fn(),
  lastActorFetchStatus: vi.fn(() => 0),
}));

vi.mock("@/lib/activitypub/remote", () => remote);

vi.mock("@/lib/activitypub/security", () => ({
  // Every signature in this file is garbage: the refresh path is what matters.
  verifySignature: vi.fn(async () => false),
}));

import { verifyIncomingSignature } from "@/lib/activitypub/signer-key";

const db = env.DB;
const SIGNER = "https://remote.example/users/alice";

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  remote.fetchAndCacheRemoteActor.mockReset();
  remote.fetchAndCacheRemoteActor.mockResolvedValue({ id: SIGNER, publicKeyPem: "pub", isLocal: false });
  await db
    .prepare(
      "INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?, 'alice', 'remote.example', 'pub', 0)"
    )
    .bind(SIGNER)
    .run();
});

function params(keyId: string) {
  return {
    method: "POST",
    url: "https://local.example.test/inbox",
    headers: {
      date: new Date().toUTCString(),
      digest: "SHA-256=aaa",
      signature: `keyId="${keyId}",headers="(request-target) host date digest",signature="Z2FyYmFnZQ=="`,
    },
    body: "{}",
    signingKeyId: keyId,
  };
}

describe("signer key refresh throttle", () => {
  it("refreshes once per actor, not once per attacker-chosen keyId fragment", async () => {
    const first = await verifyIncomingSignature(db, env.KV, params(`${SIGNER}#frag1`));
    expect(first.ok).toBe(false);
    expect(remote.fetchAndCacheRemoteActor).toHaveBeenCalledTimes(1);

    // A second invalid delivery with a *different* keyId fragment of the same
    // actor must not trigger another outbound fetch (the amplification the
    // per-key marker alone allowed).
    const second = await verifyIncomingSignature(db, env.KV, params(`${SIGNER}#frag2`));
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("invalid");
    expect(remote.fetchAndCacheRemoteActor).toHaveBeenCalledTimes(1);

    expect(await env.KV.get(`sig:refresh-actor:${SIGNER}`)).toBe("1");
  });

  it("still refreshes once for a genuinely rotated key", async () => {
    const check = await verifyIncomingSignature(db, env.KV, params(`${SIGNER}#main-key`));
    expect(check.ok).toBe(false);
    // The forced refresh ran (rotated keys come from the re-fetched document).
    expect(remote.fetchAndCacheRemoteActor).toHaveBeenCalledTimes(1);
  });
});
