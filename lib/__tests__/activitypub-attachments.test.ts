// @vitest-environment node
import { describe, it, expect } from "vitest";
import { toAPAttachment } from "@/lib/activitypub/attachments";
import type { LocalAttachment } from "@/lib/types";

function attachment(overrides: Partial<LocalAttachment> = {}): LocalAttachment {
  return {
    id: "a1",
    objectId: "obj-1",
    type: "image",
    url: "https://cf-ap.com/api/media/media/ana/foto.jpg",
    remoteUrl: null,
    description: null,
    blurhash: null,
    width: null,
    height: null,
    fileSize: null,
    mimeType: "image/jpeg",
    sensitive: false,
    createdAt: "2026-10-23T10:00:00.000Z",
    ...overrides,
  };
}

describe("toAPAttachment", () => {
  it("maps media to Image/Video/Audio", () => {
    expect(toAPAttachment(attachment()).type).toBe("Image");
    expect(toAPAttachment(attachment({ mimeType: "video/mp4" })).type).toBe("Video");
    expect(toAPAttachment(attachment({ mimeType: "audio/mpeg" })).type).toBe("Audio");
  });

  it("sends documents as a Document with their real mediaType", () => {
    // Mastodon's parser keeps `mediaType` and stores the file as its `unknown`
    // attachment type, which its clients render as a download link.
    const pdf = toAPAttachment(
      attachment({
        mimeType: "application/pdf",
        url: "https://cf-ap.com/api/media/media/ana/acta.pdf",
        description: "Acta de la reunión",
        fileSize: 1024,
        type: "unknown",
      })
    );
    expect(pdf.type).toBe("Document");
    expect(pdf.mediaType).toBe("application/pdf");
    expect(pdf.name).toBe("Acta de la reunión");
    // Dimensions and blurhash belong to media; a document has neither.
    expect(pdf.width).toBeUndefined();
    expect(pdf.height).toBeUndefined();
    expect(pdf.blurhash).toBeUndefined();

    expect(toAPAttachment(attachment({ mimeType: "text/plain" })).mediaType).toBe("text/plain");
  });

  it("falls back to a generic media type when the MIME is unknown", () => {
    const ap = toAPAttachment(attachment({ mimeType: null }));
    expect(ap.type).toBe("Document");
    expect(ap.mediaType).toBe("application/octet-stream");
  });

  it("carries the dimensions, blurhash and per-attachment sensitive flag it has", () => {
    const ap = toAPAttachment(
      attachment({ width: 640, height: 480, blurhash: "LKO2", sensitive: true, description: "gato" })
    );
    expect(ap.width).toBe(640);
    expect(ap.height).toBe(480);
    expect(ap.blurhash).toBe("LKO2");
    expect(ap.sensitive).toBe(true);
    expect(ap.name).toBe("gato");
  });
});
