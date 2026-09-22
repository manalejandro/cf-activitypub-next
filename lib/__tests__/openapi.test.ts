import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// The OpenAPI generator is a plain ESM script (no types); importing it is safe
// because its CLI entrypoint only runs when executed directly with node.
import { buildDoc } from "../../scripts/generate-openapi.mjs";

interface Operation {
  security?: unknown[];
  responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}
interface Doc {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown> };
}

const { doc } = buildDoc() as unknown as { doc: Doc };

const securityOf = (path: string, method: string): unknown[] | null =>
  doc.paths[path]?.[method]?.security ?? null;

const schemaOf = (path: string, method: string): unknown => {
  const responses = doc.paths[path]?.[method]?.responses ?? {};
  const code = Object.keys(responses).find((c) => c !== "401" && c !== "422");
  return code ? responses[code]?.content?.["application/json"]?.schema : undefined;
};

const statusRef = { $ref: "#/components/schemas/MastodonStatus" };
const locked = [{ bearerAuth: [] }];

describe("generated OpenAPI security", () => {
  it("is in sync with the route handlers (run `npm run generate:openapi` after touching a route)", () => {
    const committed = readFileSync(join(process.cwd(), "lib", "api-docs", "openapi.json"), "utf8");
    expect(`${JSON.stringify(doc, null, 2)}\n`).toBe(committed);
  });

  it("locks every /admin endpoint (administrator or moderator role)", () => {
    const adminPaths = Object.entries(doc.paths).filter(([p]) =>
      /^\/api\/(?:v\d+\/)?admin(?:\/|$)/.test(p)
    );
    expect(adminPaths.length).toBeGreaterThan(0);
    for (const [path, ops] of adminPaths) {
      for (const [method, op] of Object.entries(ops)) {
        expect(op.security, `${method.toUpperCase()} ${path} must be locked`).toEqual(locked);
      }
    }
  });

  it("locks handlers that reject a missing viewer", () => {
    for (const [path, method] of [
      ["/api/v1/accounts/verify_credentials", "get"],
      ["/api/v1/apps/verify_credentials", "get"],
      ["/api/v1/e2ee", "get"],
      ["/api/v1/calls", "post"],
      ["/api/v1/preferences", "patch"], // alias of PUT — must inherit its guard
      ["/api/v1/accounts/{id}/statuses", "get"], // remote accounts require auth
      ["/api/users/{username}/messages", "get"],
      ["/api/users/{username}/outbox", "post"],
      ["/api/v1/statuses/{id}/quotes", "get"],
    ] as const) {
      expect(securityOf(path, method), `${method.toUpperCase()} ${path} must be locked`).toEqual(locked);
    }
  });

  it("keeps credential, registration, federation and public-read endpoints open", () => {
    for (const [path, method] of [
      ["/oauth/token", "post"], // login: 401 is invalid credentials, not a missing token
      ["/api/oauth/authorize", "post"],
      ["/api/inbox", "post"], // ActivityPub inbox: HTTP signature, not bearer
      ["/inbox", "post"],
      ["/users/{username}/inbox", "post"],
      ["/api/v1/accounts", "post"], // registration
      ["/api/v1/instance", "get"],
      ["/api/v1/timelines/public", "get"],
      ["/api/v1/statuses/{id}", "get"],
      ["/api/v1/tags/search", "get"],
      ["/api/oembed", "get"],
    ] as const) {
      expect(securityOf(path, method), `${method.toUpperCase()} ${path} must be public`).toEqual([]);
    }
  });
});

describe("generated OpenAPI schemas", () => {
  it("publishes the Mastodon schema catalog derived from the types", () => {
    for (const name of [
      "MastodonAccount",
      "MastodonStatus",
      "MastodonNotification",
      "MastodonRelationship",
      "MastodonInstance",
      "MastodonCollection",
      "Error",
    ]) {
      expect(doc.components.schemas[name], `${name} schema`).toBeTruthy();
    }
    expect(Object.keys(doc.components.schemas).length).toBeGreaterThan(30);
  });

  it("expands entity schemas with properties, refs and enums", () => {
    const status = doc.components.schemas.MastodonStatus as {
      properties?: Record<string, { type?: string; enum?: string[]; $ref?: string }>;
    };
    expect(status.properties?.id).toEqual({ type: "string" });
    expect(status.properties?.visibility).toEqual({
      type: "string",
      enum: ["public", "unlisted", "private", "direct"],
    });
    expect(status.properties?.account).toEqual({ $ref: "#/components/schemas/MastodonAccount" });
    const account = doc.components.schemas.MastodonAccount as { properties?: Record<string, unknown> };
    expect(account.properties?.username).toEqual({ type: "string" });
  });

  it("wires response schemas from the serializer each handler calls", () => {
    expect(schemaOf("/api/v1/timelines/home", "get")).toEqual({ type: "array", items: statusRef });
    expect(schemaOf("/api/v1/timelines/public", "get")).toEqual({ type: "array", items: statusRef });
    expect(schemaOf("/api/v1/statuses", "post")).toEqual(statusRef);
    expect(schemaOf("/api/v1/statuses/{id}", "get")).toEqual(statusRef);
    expect(schemaOf("/api/v1/statuses/{id}/reblogged_by", "get")).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/MastodonAccount" },
    });
    expect(schemaOf("/api/v1/accounts/verify_credentials", "get")).toEqual({
      $ref: "#/components/schemas/MastodonAccount",
    });
    expect(schemaOf("/api/v1/notifications", "get")).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/MastodonNotification" },
    });
    expect(schemaOf("/api/v1/accounts/relationships", "get")).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/MastodonRelationship" },
    });
  });

  it("describes envelope responses per property", () => {
    const search = schemaOf("/api/v2/search", "get") as {
      type: string;
      properties?: Record<string, { type: string; items?: { $ref?: string } }>;
    };
    expect(search?.type).toBe("object");
    expect(search?.properties?.accounts).toEqual({ type: "array", items: { $ref: "#/components/schemas/MastodonAccount" } });
    expect(search?.properties?.statuses).toEqual({ type: "array", items: statusRef });
  });
});
