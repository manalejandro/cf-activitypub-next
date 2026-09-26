// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  metadataStripKind,
  metadataStripTransform,
  stripImageMetadata,
  stripJpegMetadata,
} from "@/lib/media/strip-metadata";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Run a length-preserving container through its streaming transform. */
async function runTransform(bytes: Uint8Array, contentType: string): Promise<Uint8Array> {
  const transform = metadataStripTransform(contentType);
  if (!transform) return bytes;
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  const reading = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        parts.push(value);
        total += value.length;
      }
    }
  })();
  await writer.write(bytes);
  await writer.close();
  await reading;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const stripMp4MetadataForTest = (bytes: Uint8Array) => runTransform(bytes, "video/mp4");
const stripMp3MetadataForTest = (bytes: Uint8Array) => runTransform(bytes, "audio/mpeg");

describe("metadataStripKind", () => {
  it("classifies images and stream containers", () => {
    expect(metadataStripKind("image/jpeg")).toBe("image");
    expect(metadataStripKind("image/png")).toBe("image");
    expect(metadataStripKind("image/webp")).toBe("image");
    expect(metadataStripKind("image/gif")).toBe("image");
    expect(metadataStripKind("video/mp4")).toBe("stream");
    expect(metadataStripKind("video/quicktime")).toBe("stream");
    expect(metadataStripKind("audio/mpeg")).toBe("stream");
    expect(metadataStripKind("image/avif")).toBeNull();
    expect(metadataStripKind("application/octet-stream")).toBeNull();
  });
});

// ── JPEG ────────────────────────────────────────────────────────────────

function jpegWithExif(): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  const app1 = [0xff, 0xe1, 0x00, 0x10, ...Array.from(encoder.encode("Exif\u0000\u0000GPS-INFO"))];
  const app0 = [0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46];
  const icc = [0xff, 0xe2, 0x00, 0x06, 0x49, 0x43, 0x43, 0x00];
  const com = [0xff, 0xfe, 0x00, 0x06, 0x68, 0x65, 0x6c, 0x6c];
  const sos = [0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x11, 0x22, 0xff, 0xd9];
  parts.push(...app1, ...app0, ...icc, ...com, ...sos);
  return new Uint8Array(parts);
}

describe("JPEG metadata", () => {
  it("drops EXIF, comments and other APPn while keeping JFIF, ICC and pixels", () => {
    const stripped = stripJpegMetadata(jpegWithExif());
    const text = decoder.decode(stripped);
    expect(text).not.toContain("Exif");
    expect(text).not.toContain("GPS-INFO");
    expect(text).not.toContain("hell");
    expect(stripped[0]).toBe(0xff);
    expect(stripped[1]).toBe(0xd8);
    // APP0 (JFIF marker "JF") and APP2 (ICC) survive.
    expect(text).toContain("JF");
    expect(text).toContain("ICC");
    // Scan data and EOI survive.
    expect(stripped[stripped.length - 2]).toBe(0xff);
    expect(stripped[stripped.length - 1]).toBe(0xd9);
    expect(stripped.length).toBeLessThan(jpegWithExif().length);
  });

  it("returns non-JPEG input untouched", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(stripImageMetadata(bytes, "image/jpeg")).toBe(bytes);
  });
});

// ── PNG ─────────────────────────────────────────────────────────────────

function pngChunk(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + payload.length);
  const length = payload.length;
  out[0] = (length >>> 24) & 0xff;
  out[1] = (length >>> 16) & 0xff;
  out[2] = (length >>> 8) & 0xff;
  out[3] = length & 0xff;
  out.set(new TextEncoder().encode(type), 4);
  out.set(payload, 8);
  return out;
}

function pngWithText(): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [
    sig,
    pngChunk("IHDR", new Uint8Array(13)),
    pngChunk("tEXt", new TextEncoder().encode("Comment=GPS")),
    pngChunk("eXIf", new Uint8Array([1, 2, 3, 4])),
    pngChunk("zTXt", new Uint8Array([0, 0, 1])),
    pngChunk("tIME", new Uint8Array(7)),
    pngChunk("iCCP", new Uint8Array(5)),
    pngChunk("IDAT", new Uint8Array(20)),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe("PNG metadata", () => {
  it("drops text/EXIF/time chunks and keeps ICC + image data", () => {
    const stripped = stripImageMetadata(pngWithText(), "image/png");
    const text = decoder.decode(stripped);
    expect(text).toContain("IHDR");
    expect(text).toContain("iCCP");
    expect(text).toContain("IDAT");
    expect(text).toContain("IEND");
    expect(text).not.toContain("tEXt");
    expect(text).not.toContain("eXIf");
    expect(text).not.toContain("zTXt");
    expect(text).not.toContain("tIME");
    expect(stripped.length).toBeLessThan(pngWithText().length);
  });
});

// ── WebP ────────────────────────────────────────────────────────────────

function webpWithExif(): Uint8Array {
  const chunk = (fourcc: string, payload: Uint8Array): Uint8Array => {
    const size = payload.length + (payload.length % 2);
    const out = new Uint8Array(8 + size);
    out.set(new TextEncoder().encode(fourcc), 0);
    out[4] = payload.length & 0xff;
    out[5] = (payload.length >>> 8) & 0xff;
    out[6] = (payload.length >>> 16) & 0xff;
    out[7] = (payload.length >>> 24) & 0xff;
    out.set(payload, 8);
    return out;
  };
  const vp8 = chunk("VP8 ", new Uint8Array([9, 9, 9]));
  const exif = chunk("EXIF", new TextEncoder().encode("GPS"));
  const xmp = chunk("XMP ", new TextEncoder().encode("xmp"));
  const bodyLength = 4 + vp8.length + exif.length + xmp.length;
  const out = new Uint8Array(8 + bodyLength);
  out.set(new TextEncoder().encode("RIFF"), 0);
  out[4] = (bodyLength + 0) & 0xff; // fixed below: RIFF size = file - 8
  out.set(new TextEncoder().encode("WEBP"), 8);
  let offset = 12;
  for (const part of [vp8, exif, xmp]) {
    out.set(part, offset);
    offset += part.length;
  }
  const riffSize = out.length - 8;
  out[4] = riffSize & 0xff;
  out[5] = (riffSize >>> 8) & 0xff;
  out[6] = (riffSize >>> 16) & 0xff;
  out[7] = (riffSize >>> 24) & 0xff;
  return out;
}

describe("WebP metadata", () => {
  it("drops EXIF/XMP chunks and fixes the RIFF size", () => {
    const stripped = stripImageMetadata(webpWithExif(), "image/webp");
    const text = decoder.decode(stripped);
    expect(text).toContain("VP8 ");
    expect(text).not.toContain("EXIF");
    expect(text).not.toContain("XMP ");
    const riffSize = (stripped[4] | (stripped[5] << 8) | (stripped[6] << 16) | (stripped[7] << 24)) >>> 0;
    expect(riffSize).toBe(stripped.length - 8);
  });
});

// ── GIF ─────────────────────────────────────────────────────────────────

function gifWithComment(): Uint8Array {
  const parts: number[] = [
    ...Array.from(new TextEncoder().encode("GIF89a")),
    0x01, 0x00, 0x01, 0x00, // logical screen
    0x80, 0x00, 0x00,       // GCT flag + size
    0x00, 0x00, 0x00, 0xff, 0xff, 0xff, // GCT
  ];
  // Comment extension.
  parts.push(0x21, 0xfe, 0x05, ...Array.from(new TextEncoder().encode("hello")), 0x00);
  // NETSCAPE loop extension.
  parts.push(0x21, 0xff, 0x0b, ...Array.from(new TextEncoder().encode("NETSCAPE2.0")), 0x03, 0x01, 0x00, 0x00, 0x00);
  // Graphic control + tiny image with one sub-block.
  parts.push(0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00);
  parts.push(0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x01, 0xaa, 0x00);
  parts.push(0x3b);
  return new Uint8Array(parts);
}

describe("GIF metadata", () => {
  it("drops comment extensions and keeps loop + image data", () => {
    const stripped = stripImageMetadata(gifWithComment(), "image/gif");
    const text = decoder.decode(stripped);
    expect(text).not.toContain("hello");
    expect(text).toContain("NETSCAPE2.0");
    expect(stripped[0]).toBe(0x47); // GIF
    expect(stripped[stripped.length - 1]).toBe(0x3b); // trailer
    expect(stripped.length).toBeLessThan(gifWithComment().length);
  });
});

// ── MP4 ─────────────────────────────────────────────────────────────────

function mp4Box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  const size = out.length;
  out[0] = (size >>> 24) & 0xff;
  out[1] = (size >>> 16) & 0xff;
  out[2] = (size >>> 8) & 0xff;
  out[3] = size & 0xff;
  for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k) & 0xff;
  out.set(payload, 8);
  return out;
}

/** QuickTime metadata atoms use the 0xA9 byte, not the UTF-8 "©". */
function mp4BoxRaw(typeBytes: number[], payload: Uint8Array): Uint8Array {
  return mp4Box(String.fromCharCode(...typeBytes), payload);
}

// (mp4Box writes the type as char codes, so 0xA9 stays a single byte.)

function mp4WithUdta(): Uint8Array {
  const ftyp = mp4Box("ftyp", new TextEncoder().encode("isomiso2"));
  const xyz = mp4BoxRaw([0xa9, 0x78, 0x79, 0x7a], new TextEncoder().encode("+40.4168-3.7038/"));
  const udta = mp4Box("udta", xyz);
  const trak = mp4Box("trak", mp4Box("udta", mp4BoxRaw([0xa9, 0x6d, 0x61, 0x6b], new TextEncoder().encode("CameraCo"))));
  const moov = mp4Box("moov", new Uint8Array([...udta, ...trak]));
  const mdatPayload = new TextEncoder().encode("PIXELDATA-".repeat(64));
  const mdat = mp4Box("mdat", mdatPayload);
  const out = new Uint8Array(ftyp.length + moov.length + mdat.length);
  out.set(ftyp, 0);
  out.set(moov, ftyp.length);
  out.set(mdat, ftyp.length + moov.length);
  return out;
}

describe("MP4 metadata", () => {
  it("zeroes udta metadata in place (same length) and keeps mdat intact", async () => {
    const input = mp4WithUdta();
    const stripped = await stripMp4MetadataForTest(input);
    expect(stripped.length).toBe(input.length);
    const text = decoder.decode(stripped);
    expect(text).not.toContain("GPS");
    expect(text).not.toContain("+40.4168-3.7038/");
    expect(text).not.toContain("CameraCo");
    expect(decoder.decode(stripped.subarray(stripped.length - 128))).toContain("PIXELDATA");
    // Box structure still parses: ftyp + moov + mdat.
    expect(decoder.decode(stripped.subarray(4, 8))).toBe("ftyp");
    const ftypSize = ((stripped[0] << 24) | (stripped[1] << 16) | (stripped[2] << 8) | stripped[3]) >>> 0;
    expect(decoder.decode(stripped.subarray(ftypSize + 4, ftypSize + 8))).toBe("moov");
  });

  it("produces the same result when fed in uneven chunks", async () => {
    const input = mp4WithUdta();
    const transform = metadataStripTransform("video/mp4")!;
    const writer = transform.writable.getWriter();
    const reader = transform.readable.getReader();
    const parts: Uint8Array[] = [];
    const reading = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) parts.push(value);
      }
    })();
    for (let i = 0; i < input.length; i += 7) {
      await writer.write(input.subarray(i, i + 7));
    }
    await writer.close();
    await reading;
    const total = parts.reduce((n, p) => n + p.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      merged.set(p, offset);
      offset += p.length;
    }
    expect(merged.length).toBe(input.length);
    expect(decoder.decode(merged)).not.toContain("CameraCo");
  });
});

// ── MP3 ─────────────────────────────────────────────────────────────────

function mp3WithTags(): Uint8Array {
  const id3Body = new TextEncoder().encode("TIT2\u0000\u0000\u0000\u0004SongGPS");
  const header = new Uint8Array([
    0x49, 0x44, 0x33, 0x03, 0x00, 0x00,
    (id3Body.length >>> 21) & 0x7f, (id3Body.length >>> 14) & 0x7f, (id3Body.length >>> 7) & 0x7f, id3Body.length & 0x7f,
  ]);
  const audio = new Uint8Array(500).fill(7);
  const id3v1 = new Uint8Array(128);
  id3v1.set(new TextEncoder().encode("TAG"), 0);
  id3v1.set(new TextEncoder().encode("Some Title"), 3);
  const out = new Uint8Array(header.length + id3Body.length + audio.length + id3v1.length);
  out.set(header, 0);
  out.set(id3Body, header.length);
  out.set(audio, header.length + id3Body.length);
  out.set(id3v1, header.length + id3Body.length + audio.length);
  return out;
}

describe("MP3 metadata", () => {
  it("blanks ID3v2 and ID3v1 tags without changing the length", async () => {
    const input = mp3WithTags();
    const stripped = await stripMp3MetadataForTest(input);
    expect(stripped.length).toBe(input.length);
    const text = decoder.decode(stripped);
    expect(text).not.toContain("SongGPS");
    expect(text).not.toContain("Some Title");
    // Audio frames untouched.
    const audioStart = 10 + new TextEncoder().encode("TIT2\u0000\u0000\u0000\u0004SongGPS").length;
    expect(stripped.subarray(audioStart, audioStart + 10)).toEqual(new Uint8Array(10).fill(7));
  });
});
