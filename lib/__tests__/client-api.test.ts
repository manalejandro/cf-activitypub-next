import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getToken, setToken, clearToken } from "@/lib/client-api";

beforeEach(() => {
  vi.stubGlobal("document", { cookie: "" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("getToken / setToken / clearToken", () => {
  it("returns null when no localStorage token exists", () => {
    expect(getToken()).toBeNull();
  });

  it("returns the token stored in localStorage", () => {
    setToken("abc123");
    expect(getToken()).toBe("abc123");
  });

  it("never reads the session cookie (it is HttpOnly now)", () => {
    Object.defineProperty(document, "cookie", {
      value: "auth_token=cookie-token; other=value",
      configurable: true,
    });
    expect(getToken()).toBeNull();
  });

  it("clearToken drops the localStorage copy", () => {
    setToken("temp");
    clearToken();
    expect(getToken()).toBeNull();
    expect(localStorage.getItem("access_token")).toBeNull();
  });
});
