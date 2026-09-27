// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import en from "@/lib/locales/en.json";
import { uploadMediaFiles, mediaUploadError } from "@/lib/media/upload-client";

const MAX_BYTES = 16 * 1024 * 1024;

function options(overrides: Partial<Parameters<typeof uploadMediaFiles>[1]> = {}) {
  return {
    token: "token-1",
    locale: "en",
    remaining: 4,
    maxAttachments: 4,
    maxBytes: MAX_BYTES,
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
    const result = await uploadMediaFiles([new File(["x"], "notes.txt", { type: "text/plain" })], options());
    expect(result.attachments).toEqual([]);
    expect(result.error).toBe(en.media_error_type);
  });

  it("fills the instance limit into the too-large message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "File too large (max 16 MB)", error_code: "media_error_too_large" }), { status: 422 })
    ));
    const result = await uploadMediaFiles([new File(["x"], "big.mp4", { type: "video/mp4" })], options());
    expect(result.error).toBe("The file is too large (max 16 MB)");
  });

  it("falls back to the server text or the generic message", async () => {
    expect(mediaUploadError({ error: "Something specific" }, en, MAX_BYTES)).toBe("Something specific");
    expect(mediaUploadError(null, en, MAX_BYTES)).toBe(en.compose_upload_error);

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
      if (name.name === "bad.txt") {
        return new Response(JSON.stringify({ error: "Unsupported file type", error_code: "media_error_type" }), { status: 422 });
      }
      return new Response(JSON.stringify(attachment), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await uploadMediaFiles(
      [new File(["a"], "bad.txt", { type: "text/plain" }), new File(["b"], "ok.png", { type: "image/png" })],
      options()
    );
    expect(result.attachments).toEqual([attachment]);
    expect(result.error).toBe(en.media_error_type);
  });
});
