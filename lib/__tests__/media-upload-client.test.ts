// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import en from "@/lib/locales/en.json";
import {
  uploadMediaFiles,
  mediaUploadError,
  mediaChipIcon,
  mediaFileName,
  documentIcon,
} from "@/lib/media/upload-client";

const IMAGE_BYTES = 16 * 1024 * 1024;
const VIDEO_BYTES = 99 * 1024 * 1024;
const DOCUMENT_BYTES = 32 * 1024 * 1024;

function options(overrides: Partial<Parameters<typeof uploadMediaFiles>[1]> = {}) {
  return {
    token: "token-1",
    locale: "en",
    remaining: 4,
    maxAttachments: 4,
    limits: { maxImageSize: IMAGE_BYTES, maxVideoSize: VIDEO_BYTES, maxDocumentSize: DOCUMENT_BYTES },
    t: en,
    ...overrides,
  };
}

const attachment = { id: "m1", type: "image", url: "https://cf-ap.com/api/media/x.png" };

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("client media upload", () => {
  it("posts each file and returns the attachments", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(attachment), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["x"], "photo.png", { type: "image/png" });

    const result = await uploadMediaFiles([file], options({ sensitive: true }));

    expect(result.attachments).toEqual([attachment]);
    expect(result.error).toBeNull();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/media");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-1");
    const form = init.body as FormData;
    expect(form.get("locale")).toBe("en");
    expect(form.get("sensitive")).toBe("true");
  });

  it("reports an unsupported type with the localized message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "Unsupported file type", error_code: "media_error_type" }), { status: 422 })
    ));
    const result = await uploadMediaFiles([new File(["x"], "archive.zip", { type: "application/zip" })], options());
    expect(result.attachments).toEqual([]);
    expect(result.error).toBe(en.media_error_type);
  });

  it("uses the per-type cap in the too-large message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "File too large", error_code: "media_error_too_large" }), { status: 413 })
    ));

    // A video is judged against the video limit, not the image one…
    const video = await uploadMediaFiles([new File(["x"], "big.mp4", { type: "video/mp4" })], options());
    expect(video.error).toBe("The file is too large (max 99 MB)");

    // …and a document against the document limit.
    const document = await uploadMediaFiles([new File(["x"], "big.pdf", { type: "application/pdf" })], options());
    expect(document.error).toBe("The file is too large (max 32 MB)");
  });

  it("falls back to the server text or the generic message", async () => {
    expect(mediaUploadError({ error: "Something specific" }, en, IMAGE_BYTES)).toBe("Something specific");
    expect(mediaUploadError(null, en, IMAGE_BYTES)).toBe(en.compose_upload_error);

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    const result = await uploadMediaFiles([new File(["x"], "photo.png", { type: "image/png" })], options());
    expect(result.error).toBe(en.compose_upload_error);
  });

  it("caps the batch at the remaining slots and says so", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(attachment), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await uploadMediaFiles(
      [new File(["a"], "a.png", { type: "image/png" }), new File(["b"], "b.png", { type: "image/png" })],
      options({ remaining: 1 })
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.attachments).toHaveLength(1);
    expect(result.error).toBe("You can attach up to 4 files");
  });

  it("keeps the successful files when one is rejected", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const name = (init.body as FormData).get("file") as File;
      if (name.name === "bad.zip") {
        return new Response(JSON.stringify({ error: "Unsupported file type", error_code: "media_error_type" }), { status: 422 });
      }
      return new Response(JSON.stringify(attachment), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await uploadMediaFiles(
      [new File(["a"], "bad.zip", { type: "application/zip" }), new File(["b"], "ok.png", { type: "image/png" })],
      options()
    );
    expect(result.attachments).toEqual([attachment]);
    expect(result.error).toBe(en.media_error_type);
  });
});

describe("attachment presentation helpers", () => {
  it("picks the chip icon from the attachment type", () => {
    expect(mediaChipIcon({ type: "audio", url: "https://x.test/a.mp3" })).toBe("music");
    expect(mediaChipIcon({ type: "video", url: "https://x.test/a.mp4" })).toBe("film");
    expect(mediaChipIcon({ type: "image", url: "https://x.test/a.png" })).toBe("film");
    // Documents get a file icon, and a PDF is recognizable at a glance.
    expect(mediaChipIcon({ type: "unknown", url: "https://x.test/media/u/report.pdf" })).toBe("file-pdf-o");
    expect(mediaChipIcon({ type: "unknown", url: "https://x.test/media/u/notes.txt" })).toBe("file-text-o");
    expect(documentIcon("https://x.test/a.pdf?v=2")).toBe("file-pdf-o");
    expect(documentIcon(null)).toBe("file-text-o");
  });

  it("recovers the uploaded file name from the storage key", () => {
    // Modern keys keep the original name after the uuid…
    expect(mediaFileName("https://cf-ap.com/api/media/media/ana/6f1c1d5a-0f3e-4a77-9d5f-3a1d6f9c6a2b-informe.pdf")).toBe("informe.pdf");
    // …old ones only have the id, so the extension is all there is.
    expect(mediaFileName("https://cf-ap.com/api/media/media/ana/6f1c1d5a0f3e4a779d5f3a1d6f9c6a2b.pdf")).toBe("PDF");
    expect(mediaFileName("https://cf-ap.com/api/media/media/ana/notas.txt")).toBe("notas.txt");
    expect(mediaFileName(null)).toBeNull();
  });
});
