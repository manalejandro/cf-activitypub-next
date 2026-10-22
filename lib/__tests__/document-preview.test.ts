// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  DOCUMENT_PREVIEW_MAX_BYTES,
  documentPreviewKind,
  documentPreviewUrl,
  readCappedText,
} from "@/lib/media/document-preview";

describe("documentPreviewKind", () => {
  it("recognizes PDFs by MIME or by extension", () => {
    expect(documentPreviewKind("https://x.test/media/u/acta", "application/pdf")).toBe("pdf");
    expect(documentPreviewKind("https://x.test/media/u/acta.pdf")).toBe("pdf");
    expect(documentPreviewKind("https://x.test/media/u/acta.pdf?token=1#page=2")).toBe("pdf");
    // Cached remote documents keep the origin extension in the storage key.
    expect(documentPreviewKind("https://x.test/api/media/cache/media/ab12cd.pdf")).toBe("pdf");
  });

  it("recognizes text by MIME or by extension", () => {
    expect(documentPreviewKind("https://x.test/media/u/notas", "text/plain")).toBe("text");
    expect(documentPreviewKind("https://x.test/media/u/notas", "text/markdown")).toBe("text");
    for (const name of ["notas.txt", "README.md", "datos.csv", "server.log", "config.json", "feed.xml"]) {
      expect(documentPreviewKind(`https://x.test/media/u/${name}`)).toBe("text");
    }
  });

  it("gives no preview to anything else", () => {
    expect(documentPreviewKind("https://x.test/media/u/acta.docx")).toBe("none");
    expect(documentPreviewKind("https://x.test/media/u/paquete.zip")).toBe("none");
    expect(documentPreviewKind("https://x.test/media/u/hoja.xlsx")).toBe("none");
    expect(documentPreviewKind(null)).toBe("none");
  });
});

describe("documentPreviewUrl", () => {
  it("resolves our own media path to the current origin", () => {
    // The stored URL points at INSTANCE_URL; the page may be served by another
    // host of the same instance, where a relative path is same-origin (CSP
    // connect-src, framing, and a working `download` attribute).
    expect(documentPreviewUrl("https://cf-ap.com/api/media/media/ana/acta.pdf")).toBe("/api/media/media/ana/acta.pdf");
    expect(documentPreviewUrl("https://cf-ap.com/api/media/cache/media/ab12.pdf?v=2")).toBe("/api/media/cache/media/ab12.pdf?v=2");
  });

  it("leaves remote and relative URLs alone", () => {
    expect(documentPreviewUrl("https://remote.example/files/acta.pdf")).toBe("https://remote.example/files/acta.pdf");
    expect(documentPreviewUrl("/api/media/media/ana/acta.pdf")).toBe("/api/media/media/ana/acta.pdf");
    expect(documentPreviewUrl("not a url")).toBe("not a url");
  });
});

describe("readCappedText", () => {
  it("returns small files whole", async () => {
    const response = new Response("hola mundo");
    const result = await readCappedText(response);
    expect(result.text).toBe("hola mundo");
    expect(result.truncated).toBe(false);
    expect(result.totalBytes).toBe(10);
  });

  it("stops at the cap and cancels the rest of a big body", async () => {
    // 1 MB of "a" — the viewer must not buffer it all.
    const chunk = new TextEncoder().encode("a".repeat(64 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 16) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const response = new Response(stream);

    const result = await readCappedText(response, 1024);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(1024);
    // The reader stopped early instead of walking the whole body.
    expect(sent).toBeLessThan(16);
  });

  it("trusts content-range for the total size (the 206 path)", async () => {
    const response = new Response("primeros bytes", {
      status: 206,
      headers: { "content-range": `bytes 0-13/1048576` },
    });
    const result = await readCappedText(response, 4096);
    expect(result.text).toBe("primeros bytes");
    expect(result.truncated).toBe(true);
    expect(result.totalBytes).toBe(1048576);
  });

  it("exposes the documented cap", () => {
    expect(DOCUMENT_PREVIEW_MAX_BYTES).toBe(256 * 1024);
  });
});
