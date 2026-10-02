// @vitest-environment node
import { describe, it, expect } from "vitest";
import { buildActor, buildNote } from "@/lib/activitypub/utils";
import { emojiImgsToShortcodes, fieldValueForVerification } from "@/lib/activitypub/content";

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

describe("profile field verification", () => {
  it("wraps https field values in an anchor (a plain URL is never verified)", () => {
    expect(fieldValueForVerification("https://manalejandro.com")).toBe(
      '<a href="https://manalejandro.com" rel="me">https://manalejandro.com</a>'
    );
    expect(fieldValueForVerification("https://manalejandro.dev?a=1&b=2")).toBe(
      '<a href="https://manalejandro.dev?a=1&amp;b=2" rel="me">https://manalejandro.dev?a=1&amp;b=2</a>'
    );
  });

  it("leaves values that are not https URLs as typed", () => {
    expect(fieldValueForVerification("@manalejandro")).toBe("@manalejandro");
    expect(fieldValueForVerification("manalejandro.dev")).toBe("manalejandro.dev");
    expect(fieldValueForVerification("http://manalejandro.com")).toBe("http://manalejandro.com");
  });

  it("emits the anchor in the actor attachment", () => {
    const actor = buildActor("https://cf-ap.com", "manalejandro", {
      publicKeyPem: "pem",
      fields: [{ name: "Web", value: "https://manalejandro.com" }],
    } as never);

    const attachment = actor.attachment as { value: string }[];
    expect(attachment[0].value).toBe(
      '<a href="https://manalejandro.com" rel="me">https://manalejandro.com</a>'
    );
  });
});

describe("buildNote", () => {
  it("sends shortcodes in the AP content (Mastodon drops rendered images)", () => {
    const note = buildNote("https://cf-ap.com", "abc-123", {
      actorUsername: "manalejandro",
      content: `<p>hola ${EMOJI_IMG}</p>`,
      published: "2026-10-02T00:00:00Z",
      visibility: "public",
      tags: [
        {
          type: "Emoji",
          name: ":cfactivitypub:",
          icon: { type: "Image", id: "https://cf-ap.com/api/media/emoji/cfactivitypub/abc.png", url: "https://cf-ap.com/api/media/emoji/cfactivitypub/abc.png" },
        },
      ],
    });

    expect(note.content).toBe("<p>hola :cfactivitypub:</p>");
    expect((note.tag as { name: string }[])[0].name).toBe(":cfactivitypub:");
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
