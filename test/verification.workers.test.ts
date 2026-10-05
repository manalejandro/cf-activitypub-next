import { beforeAll, describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

beforeAll(async () => {
  await applyTestSchema();
});

const federation = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  signedGetHeaders: vi.fn().mockResolvedValue({}),
  validateOutboundUrl: vi.fn(() => ({ valid: true })),
}));

vi.mock("@/lib/activitypub/federation", () => federation);

import { verifyAccountFields } from "@/lib/activitypub/verification";

const ACTOR = "https://remote.example/users/fan";

const db = env.DB;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  federation.safeFetch.mockReset();
  federation.validateOutboundUrl.mockReset();
  federation.validateOutboundUrl.mockReturnValue({ valid: true });
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await resetTestDatabase();

  await db.prepare(
    `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
     VALUES (?, 'fan', 'remote.example', 'k', NULL, 0)`
  ).bind(ACTOR).run();

  const insertField = db.prepare(
    "INSERT INTO actor_fields (id, actor_id, name, value, position) VALUES (?,?,?,?,?)"
  );
  await insertField.bind("f-http", ACTOR, "Lattes", '<a href="http://buscatextual.cnpq.br/x?id=1">cv</a>', 0).run();
  await insertField.bind("f-https", ACTOR, "Blog", '<a href="https://blog.example/">blog</a>', 1).run();
});

describe("verifyAccountFields", () => {
  it("skips plain-http field URLs without fetching or logging a blocked request", async () => {
    federation.safeFetch.mockResolvedValue(null);

    const result = await verifyAccountFields(db, ACTOR, "local.example");
    expect(result.verifiedFields).toBe(0);

    // Only the https field is fetched; the http one is dropped quietly.
    expect(federation.safeFetch).toHaveBeenCalledTimes(1);
    const fetched = String(federation.safeFetch.mock.calls[0][0]);
    expect(fetched).toBe("https://blog.example/");
    expect(federation.validateOutboundUrl).not.toHaveBeenCalledWith("http://buscatextual.cnpq.br/x?id=1");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not fetch anything when every field is plain http", async () => {
    await db.prepare("DELETE FROM actor_fields WHERE id = 'f-https'").bind().run();
    const result = await verifyAccountFields(db, ACTOR, "local.example");
    expect(result.verifiedFields).toBe(0);
    expect(federation.safeFetch).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
