// @vitest-environment node
import { describe, it, expect } from "vitest";
import { stripPdfMetadata } from "@/lib/media/strip-pdf";
import { metadataStripKind, metadataStripBuffers, stripMetadataBytes } from "@/lib/media/strip-metadata";

/** Binary string (every char is one byte, code < 256) → bytes. */
function toBytes(bin: string): Uint8Array {
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

function toBin(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return out;
}

async function deflateBin(bin: string): Promise<string> {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  const writing = writer.write(toBytes(bin) as unknown as BufferSource).then(() => writer.close());
  const reader = cs.readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      parts.push(value);
      total += value.byteLength;
    }
  }
  await writing;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return toBin(out);
}

interface Obj {
  num: number;
  gen?: number;
  body: string;
}

/** Classic single-revision PDF with an exact xref table. */
function assemble(objects: Obj[], trailerDict: string): string {
  let out = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
  const offsets = new Map<number, number>();
  for (const o of objects) {
    offsets.set(o.num, out.length);
    out += `${o.num} ${o.gen ?? 0} obj\n${o.body}\nendobj\n`;
  }
  const xrefStart = out.length;
  const maxNum = Math.max(...objects.map((o) => o.num));
  out += `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxNum; i++) {
    const off = offsets.get(i);
    out += off !== undefined ? `${String(off).padStart(10, "0")} 00000 n \n` : `0000000000 65535 f \n`;
  }
  out += `trailer\n<< /Size ${maxNum + 1} ${trailerDict} >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return out;
}

// Stream data deliberately containing the structural keywords: the scanner
// must skip payloads by length, never by naive searching.
const CONTENT_DATA = "BT /F1 12 Tf (Body text stays) Tj ET\nendobj\nstream\nendstream trailer startxref 999999";
const XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta><Author>SecretAuthor</Author></x:xmpmeta><?xpacket end="w"?>`;

function simpleObjects(): Obj[] {
  return [
    { num: 1, body: "<< /Type /Catalog /Pages 2 0 R /Metadata 5 0 R >>" },
    { num: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { num: 3, body: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>" },
    { num: 4, body: `<< /Length ${CONTENT_DATA.length} >>\nstream\n${CONTENT_DATA}\nendstream` },
    { num: 5, body: `<< /Type /Metadata /Subtype /XML /Length ${XMP.length} >>\nstream\n${XMP}\nendstream` },
    { num: 6, body: "<< /Title (Confidential Report) /Author (Jane Doe) /Producer (LeakyTool 9000) /CreationDate (D:20260101120000Z) >>" },
  ];
}

const SIMPLE_TRAILER = "/Root 1 0 R /Info 6 0 R /ID [<0123456789abcdef0123456789abcdef> <0123456789abcdef0123456789abcdef>]";

/** Locate object `num`'s xref entry offset in a rebuilt file and check it. */
function lastStartxref(out: string): number {
  // The content stream deliberately embeds "startxref 999999": like the
  // implementation, the LAST occurrence in the tail is the real one.
  let sx = -1;
  for (const m of out.matchAll(/startxref\s+(\d+)/g)) sx = Number(m[1]);
  expect(sx).toBeGreaterThan(0);
  return sx;
}

function expectValidXref(out: string, num: number): void {
  const sx = lastStartxref(out);
  expect(out.startsWith("xref", sx)).toBe(true);
  const header = /^xref\n0 (\d+)\n/.exec(out.slice(sx))!;
  const entriesStart = sx + header[0].length;
  const entry = out.slice(entriesStart + 20 * num, entriesStart + 20 * (num + 1));
  expect(entry[17]).toBe("n");
  const offset = Number(entry.slice(0, 10));
  expect(out.startsWith(`${num} 0 obj`, offset)).toBe(true);
}

describe("stripPdfMetadata", () => {
  it("removes Info, XMP metadata and the catalog reference, keeping the content", async () => {
    const out = toBin(await stripPdfMetadata(toBytes(assemble(simpleObjects(), SIMPLE_TRAILER))));

    expect(out).not.toContain("Confidential Report");
    expect(out).not.toContain("Jane Doe");
    expect(out).not.toContain("LeakyTool");
    expect(out).not.toContain("SecretAuthor");
    expect(out).not.toContain("/Info");
    expect(out).not.toContain("/Metadata");
    expect(out).not.toContain("0123456789abcdef"); // the old file ID is gone
    // The page content survives byte-for-byte, tricky keywords included.
    expect(out).toContain(CONTENT_DATA);
    expect(out).toContain("/Type /Catalog");
    expect(out).toContain("/Root 1 0 R");
    expect(out).toContain("%%EOF");
    // One REAL startxref (the content stream embeds the word on purpose).
    expect(out.match(/startxref\s+\d+\s*%%EOF/g)!.length).toBe(1);
    expectValidXref(out, 1);
    expectValidXref(out, 4);
    // The dropped objects left no xref ghosts: the fresh table covers 0..4
    // (the highest kept object), so 5 (XMP) and 6 (Info) have no entries.
    const sx = lastStartxref(out);
    const header = /^xref\n0 (\d+)\n/.exec(out.slice(sx))!;
    expect(Number(header[1])).toBe(5);
  });

  it("drops the whole revision history of an incrementally updated file", async () => {
    const rev1 = assemble(simpleObjects(), SIMPLE_TRAILER);
    const xref1 = Number(/startxref\s+(\d+)\s+%%EOF/.exec(rev1)![1]);
    // Revision 2 appends a new Info object and its own xref section.
    const off6 = rev1.length;
    const rev2 =
      `6 0 obj\n<< /Title (NEWSECRET) /Author (Second Author) >>\nendobj\n`;
    const xref2 = off6 + rev2.length;
    const file =
      rev1 +
      rev2 +
      `xref\n6 1\n${String(off6).padStart(10, "0")} 00000 n \n` +
      `trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R /Prev ${xref1} >>\nstartxref\n${xref2}\n%%EOF\n`;

    const out = toBin(await stripPdfMetadata(toBytes(file)));
    expect(out).not.toContain("NEWSECRET");
    expect(out).not.toContain("Second Author");
    expect(out).not.toContain("Confidential Report"); // revision 1's Info is history
    expect(out).not.toContain("Jane Doe");
    expect(out).not.toContain("SecretAuthor");
    expect(out).toContain(CONTENT_DATA);
    expect(out.match(/startxref\s+\d+\s*%%EOF/g)!.length).toBe(1); // single fresh revision
    expectValidXref(out, 1);
  });

  it("expands object streams and reads xref-stream trailers", async () => {
    const pages = "<< /Type /Pages /Kids [] /Count 0 >>";
    const info = "<< /Title (CompressedSecret) /Author (Hidden Person) >>";
    const headerStr = `2 0 3 ${pages.length + 1}`;
    const first = headerStr.length + 1;
    const payload = `${headerStr}\n${pages} ${info}`;
    const compStm = await deflateBin(payload);

    let file = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
    const off1 = file.length;
    file += "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
    const off4 = file.length;
    file += `4 0 obj\n<< /Type /ObjStm /N 2 /First ${first} /Length ${compStm.length} /Filter /FlateDecode >>\nstream\n${compStm}\nendstream\nendobj\n`;
    const off5 = file.length;
    const be = (v: number, width: number): string => {
      let s = "";
      for (let i = width - 1; i >= 0; i--) s += String.fromCharCode((v >>> (8 * i)) & 0xff);
      return s;
    };
    const entry = (t: number, f2: number, f3: number): string => be(t, 1) + be(f2, 4) + be(f3, 2);
    const xrefData =
      entry(0, 0, 0) + entry(1, off1, 0) + entry(2, 4, 0) + entry(3, 4, 1) + entry(1, off4, 0) + entry(1, off5, 0);
    const compXref = await deflateBin(xrefData);
    file += `5 0 obj\n<< /Type /XRef /Size 6 /W [1 4 2] /Index [0 6] /Root 1 0 R /Info 3 0 R /Filter /FlateDecode /Length ${compXref.length} >>\nstream\n${compXref}\nendstream\nendobj\n`;
    file += `startxref\n${off5}\n%%EOF\n`;

    const out = toBin(await stripPdfMetadata(toBytes(file)));
    // The compressed page object was expanded into a plain indirect object…
    expect(out).toContain("2 0 obj");
    expect(out).toContain("/Type /Pages");
    // …the compressed Info died with the object stream, and the classic table replaced the XRef stream.
    expect(out).not.toContain("CompressedSecret");
    expect(out).not.toContain("Hidden Person");
    expect(out).not.toContain("/Info");
    expect(out).not.toContain("/Type /XRef");
    expect(out).toContain("/Root 1 0 R");
    expect(out).toContain("xref\n0 ");
    expect(out).toContain("%%EOF");
    expectValidXref(out, 1);
    expectValidXref(out, 2);
  });

  it("passes encrypted files through untouched", async () => {
    const objects = [...simpleObjects(), { num: 7, body: "<< /Filter /Standard /V 2 /R 3 >>" }];
    const bytes = toBytes(assemble(objects, `${SIMPLE_TRAILER} /Encrypt 7 0 R`));
    const out = await stripPdfMetadata(bytes);
    expect(out).toBe(bytes); // fail open: the ORIGINAL buffer, byte-identical
  });

  it("passes unparseable files through untouched", async () => {
    const garbage = toBytes("%PDF-1.7\nthis is not a pdf, no xref, no objects\n");
    expect(await stripPdfMetadata(garbage)).toBe(garbage);
    const notPdf = toBytes("PK\u0003\u0004 some other binary format entirely");
    expect(await stripPdfMetadata(notPdf)).toBe(notPdf);
  });

  it("handles streams with an indirect /Length", async () => {
    const objects: Obj[] = [
      { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      { num: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
      { num: 3, body: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>" },
      { num: 4, body: `<< /Length 7 0 R >>\nstream\n${CONTENT_DATA}\nendstream` },
      { num: 6, body: "<< /Title (Indirect Length Secret) >>" },
      { num: 7, body: String(CONTENT_DATA.length) },
    ];
    const out = toBin(await stripPdfMetadata(toBytes(assemble(objects, "/Root 1 0 R /Info 6 0 R"))));
    expect(out).not.toContain("Indirect Length Secret");
    expect(out).toContain(CONTENT_DATA);
    expectValidXref(out, 4);
  });
});

describe("metadataStripKind wiring", () => {
  it("classifies PDFs as a buffered, length-changing kind", () => {
    expect(metadataStripKind("application/pdf")).toBe("pdf");
    expect(metadataStripKind("APPLICATION/PDF")).toBe("pdf");
    expect(metadataStripKind("text/plain")).toBeNull();
    expect(metadataStripBuffers("pdf")).toBe(true);
    expect(metadataStripBuffers("image")).toBe(true);
    expect(metadataStripBuffers("stream")).toBe(false);
    expect(metadataStripBuffers(null)).toBe(false);
  });

  it("routes application/pdf through stripMetadataBytes", async () => {
    const bytes = toBytes(assemble(simpleObjects(), SIMPLE_TRAILER));
    const out = toBin(await stripMetadataBytes(bytes, "application/pdf"));
    expect(out).not.toContain("Confidential Report");
    expect(out).toContain("Body text stays");
  });
});
