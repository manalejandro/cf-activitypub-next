import { describe, expect, it } from "vitest";
import { profileHref } from "@/lib/profile-link";

describe("profileHref", () => {
  it("links a local account to its own profile page", () => {
    expect(profileHref({ id: "https://cf-ap.com/users/alice", username: "alice", acct: "alice" })).toBe("/users/alice");
  });

  it("resolves a remote account through the local viewer, never the remote web URL", () => {
    const id = "https://remote.example/users/bob";
    expect(profileHref({ id, username: "bob", acct: "bob@remote.example" })).toBe(
      `/users/remote?url=${encodeURIComponent(id)}`
    );
  });
});
