// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import { encodeStatusId } from "@/lib/mastodon/statusId";

const db = {};
const getObjectById = vi.hoisted(() => vi.fn());
const getActorById = vi.hoisted(() => vi.fn());
const getAuthenticatedActor = vi.hoisted(() => vi.fn());

vi.mock("@/lib/cf", () => ({ getCloudflareContext: () => ({ env: { DB: db } }) }));
vi.mock("@/lib/db", () => ({ getObjectById, getActorById }));
vi.mock("@/lib/auth", () => ({ getAuthenticatedActor }));

import { GET } from "@/app/authorize_interaction/route";

function req(url: string, headers: Record<string, string> = {}): NextRequest {
  return { nextUrl: new URL(url), headers: new Headers(headers), url } as unknown as NextRequest;
}

beforeEach(() => {
  getObjectById.mockReset();
  getActorById.mockReset();
  getAuthenticatedActor.mockReset();
});

describe("authorize_interaction", () => {
  it("sends anonymous visitors to login preserving the interaction", async () => {
    getObjectById.mockResolvedValue(null);
    getActorById.mockResolvedValue(null);
    getAuthenticatedActor.mockResolvedValue(null);
    const remote = "https://remote.example/users/a/statuses/1";
    const res = await GET(req(`https://local.example/authorize_interaction?uri=${encodeURIComponent(remote)}`));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("uri")).toBe(remote);
    expect(location.searchParams.get("redirect")).toBe(
      `/statuses/${encodeURIComponent(encodeStatusId(remote, false))}`
    );
  });

  it("resolves a cached local object to its thread when authenticated", async () => {
    getObjectById.mockResolvedValue({ local: true });
    getAuthenticatedActor.mockResolvedValue({ id: "https://local.example/users/me" });
    const uri = "https://local.example/objects/abc";
    const res = await GET(req(`https://local.example/authorize_interaction?uri=${encodeURIComponent(uri)}`));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/statuses/abc");
  });

  it("routes actors to the remote profile resolver", async () => {
    getObjectById.mockResolvedValue(null);
    getActorById.mockResolvedValue({ isLocal: false });
    getAuthenticatedActor.mockResolvedValue({ id: "https://local.example/users/me" });
    const uri = "https://remote.example/users/alice";
    const res = await GET(req(`https://local.example/authorize_interaction?uri=${encodeURIComponent(uri)}`));
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/users/remote");
    expect(location.searchParams.get("url")).toBe(uri);
  });

  it("forwards the referring instance to the login page", async () => {
    getObjectById.mockResolvedValue(null);
    getActorById.mockResolvedValue(null);
    getAuthenticatedActor.mockResolvedValue(null);
    const remote = "https://remote.example/users/a/statuses/1";
    const res = await GET(req(
      `https://local.example/authorize_interaction?uri=${encodeURIComponent(remote)}`,
      { referer: "https://cf-ap.example/users/me/statuses/2" }
    ));
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("from")).toBe("cf-ap.example");
  });

  it("falls back to login when no uri is given", async () => {
    const res = await GET(req("https://local.example/authorize_interaction"));
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });
});
