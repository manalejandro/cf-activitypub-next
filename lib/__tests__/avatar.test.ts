import { describe, it, expect } from "vitest";
import { avatarInitial } from "@/lib/avatar";

describe("avatarInitial", () => {
  it("skips emoji and decorations in the display name", () => {
    expect(avatarInitial("🌸 ana", "ana")).toBe("A");
    expect(avatarInitial("«cita»", "cita")).toBe("C");
    expect(avatarInitial("  @casa", "casa")).toBe("C");
    expect(avatarInitial("👨‍👩‍👧 familia", "familia")).toBe("F");
    expect(avatarInitial("✨", "estrella")).toBe("E");
  });

  it("keeps letters, accents, digits and non-latin scripts", () => {
    expect(avatarInitial("Ángel", "angel")).toBe("Á");
    expect(avatarInitial("123abc", "abc")).toBe("1");
    expect(avatarInitial("東京", "tokyo")).toBe("東");
    expect(avatarInitial("ана", "ana")).toBe("А");
  });

  it("falls back to the username when the display name has nothing usable", () => {
    expect(avatarInitial("🎉", "usuario")).toBe("U");
    expect(avatarInitial(null, "usuario")).toBe("U");
    expect(avatarInitial("", "usuario")).toBe("U");
    expect(avatarInitial(undefined, undefined)).toBe("?");
    expect(avatarInitial("!!!", "!!!")).toBe("?");
  });

  it("never cuts a surrogate pair in half", () => {
    // U+1F600 is a surrogate pair in UTF-16: `[0]` would render a lone half.
    expect(avatarInitial("😀sonrisa", "sonrisa")).toBe("S");
  });
});
