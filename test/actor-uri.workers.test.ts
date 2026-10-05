import { beforeAll, describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

beforeAll(async () => {
  await applyTestSchema();
});
import { getActorByUri } from "@/lib/db";

const db = env.DB;

const PEM = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----";

beforeEach(async () => {
  await resetTestDatabase();

  const insert = db.prepare(
    `INSERT INTO actors (id, username, domain, display_name, public_key_pem, is_local, inbox)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  await insert.bind(
    "https://mastodon.la/users/hcv13",
    "hcv13",
    "mastodon.la",
    "hcv13",
    PEM,
    0,
    "https://mastodon.la/users/hcv13/inbox"
  ).run();
  await insert.bind(
    "https://cf-ap.com/users/ale",
    "ale",
    "cf-ap.com",
    "ale",
    PEM,
    1,
    "https://cf-ap.com/users/ale/inbox"
  ).run();
});

describe("getActorByUri", () => {
  it("resolves the canonical actor id", async () => {
    const a = await getActorByUri(db, "https://mastodon.la/users/hcv13");
    expect(a?.username).toBe("hcv13");
    expect(a?.domain).toBe("mastodon.la");
  });

  it("resolves the web profile URL (@username) of a remote actor", async () => {
    const a = await getActorByUri(db, "https://mastodon.la/@hcv13");
    expect(a?.username).toBe("hcv13");
    expect(a?.domain).toBe("mastodon.la");
  });

  it("resolves the plain acct form (name@host)", async () => {
    const a = await getActorByUri(db, "hcv13@mastodon.la");
    expect(a?.username).toBe("hcv13");
    expect(a?.domain).toBe("mastodon.la");
  });

  it("returns null for an unknown actor", async () => {
    expect(await getActorByUri(db, "https://unknown.example/@nobody")).toBeNull();
    expect(await getActorByUri(db, "nobody@unknown.example")).toBeNull();
    expect(await getActorByUri(db, "not a uri")).toBeNull();
  });

  it("resolves local actors by canonical id too", async () => {
    const a = await getActorByUri(db, "https://cf-ap.com/users/ale");
    expect(a?.username).toBe("ale");
  });
});
