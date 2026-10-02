// @vitest-environment node
import { describe, it, expect } from "vitest";
import { buildActor } from "@/lib/activitypub/utils";
import { emojiImgsToShortcodes } from "@/lib/activitypub/content";

const EMOJI_IMG =
  '<img src="https://cf-ap.com/api/media/emoji/cfactivitypub/abc.png" alt=":cfactivitypub:" class="emojione custom-emoji" rel="emoji" title=":cfactivitypub:" width="16" height="16" />';

describe("emojiImgsToShortcodes", () => {
  it("turns emoji images back into shortcodes", () => {
    expect(emojiImgsToShortcodes(`<p>${EMOJI_IMG}<br />hola</p>`)).toBe("<p>:cfactivitypub:<br />hola</p>");
  });

  it("leaves other images and plain text alone", () => {
    const photo = '<p><img src="https://x.example/a.png" alt="foto" /></p>';
    expect(emojiImgsToShortcodes(photo)).toBe(photo);
    expect(emojiImgsToShortcodes("sin emojis")).toBe("sin emojis");
    expect(emojiImgsToShortcodes("")).toBe("");
  });
});

describe("buildActor", () => {
  it("sends the source note (shortcodes) so remote instances render the emoji", () => {
    const actor = buildActor("https://cf-ap.com", "manalejandro", {
      displayName: "ale",
      summary: `<p>${EMOJI_IMG}<br />hola</p>`,
      publicKeyPem: "pem",
      tags: [
        {
          type: "Emoji",
          name: ":cfactivitypub:",
          icon: { type: "Image", url: "https://cf-ap.com/api/media/emoji/cfactivitypub/abc.png" },
        },
      ],
    } as never);

    // Mastodon drops <img> from a remote summary and only replaces shortcodes,
    // so the actor document must carry the source text plus the tag array.
    expect(actor.summary).toBe("<p>:cfactivitypub:<br />hola</p>");
    expect((actor.tag as { name: string }[])[0].name).toBe(":cfactivitypub:");
  });

  it("keeps a display name without emojis untouched", () => {
    const actor = buildActor("https://cf-ap.com", "manalejandro", {
      displayName: "ale",
      summary: "<p>hola</p>",
      publicKeyPem: "pem",
    } as never);
    expect(actor.name).toBe("ale");
    expect(actor.summary).toBe("<p>hola</p>");
  });
});
