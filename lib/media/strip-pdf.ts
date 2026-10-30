/**
 * PDF metadata stripping by structural rebuild.
 *
 * PDFs cannot be cleaned in place like the image/AV containers in
 * `strip-metadata.ts`: the metadata lives in the object graph — the trailer's
 * `/Info` dictionary (Title/Author/Creator/Producer/dates), the catalog's
 * `/Metadata` XMP stream (which routinely embeds author identities, tool
 * chains, thumbnails and document history), the file `/ID`, and — crucially —
 * every incremental revision a writer appended keeps ALL of that alive in the
 * file's history even after a "clean" update.
 *
 * So this module rebuilds the document as ONE fresh revision:
 *
 *  - walks the xref chain (classic tables, 1.5 cross-reference streams and
 *    hybrid files, `/Prev` links) keeping the newest definition of each
 *    object — old revisions, freed objects and the stale xref machinery are
 *    dropped, which is what removes the history carving surface;
 *  - expands PDF 1.5 object streams (`ObjStm`, Flate) into plain indirect
 *    objects so the rebuilt file needs only a classic xref table;
 *  - removes every revision's `/Info` object, the catalog's `/Metadata`
 *    stream (patching the reference out of the catalog) and the `/Type/XRef`
 *    stream objects;
 *  - writes a new xref table, a trailer with a freshly generated `/ID` and
 *    `%%EOF`.
 *
 * Fail-open contract: encrypted files (`/Encrypt` — rewriting them needs the
 * key) and anything that does not parse exactly (broken xref, unresolvable
 * object extents, non-Flate object streams) return the ORIGINAL bytes. A
 * damaged rewrite of somebody's document is worse than metadata we could not
 * remove, and the warning says so in the logs.
 *
 * Memory: structural scanning decodes small windows (dictionaries, headers)
 * and searches big regions in 1 MB chunks — the whole file is never held as a
 * JS string. Decompression is capped (bomb guard).
 */

// ─────────────────────────────────────────
// Byte-transparent string helpers
// ─────────────────────────────────────────
// TextDecoder("latin1") maps 0x80-0x9f to Unicode punctuation (€ etc.) and
// cannot be encoded back losslessly; structural work needs byte<->char 1:1.

function binOf(bytes: Uint8Array, from = 0, to = bytes.length): string {
  const end = Math.max(from, Math.min(to, bytes.length));
  let out = "";
  const CHUNK = 0x8000;
  for (let i = from; i < end; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, end)));
  }
  return out;
}

function bytesOf(bin: string): Uint8Array {
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

/** indexOf over a byte range, decoded in bounded windows (large stream data). */
function indexOfBytes(bytes: Uint8Array, pattern: string, from: number, to: number): number {
  const CHUNK = 1 << 20;
  const overlap = Math.max(0, pattern.length - 1);
  const limit = Math.min(to, bytes.length);
  for (let base = Math.max(0, from); base < limit; base += CHUNK - overlap) {
    const end = Math.min(limit, base + CHUNK);
    const idx = binOf(bytes, base, end).indexOf(pattern);
    if (idx !== -1) return base + idx;
    if (end >= limit) break;
  }
  return -1;
}

async function inflate(data: Uint8Array, cap: number): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === "undefined") return null;
  try {
    const ds = new DecompressionStream("deflate"); // zlib wrapper = FlateDecode
    const writer = ds.writable.getWriter();
    // The DOM lib types the writable as BufferSource (ArrayBuffer-backed);
    // our bytes may sit on an ArrayBufferLike — the runtime accepts both.
    const writing = writer
      .write(data as unknown as BufferSource)
      .then(() => writer.close())
      .catch(() => {});
    const reader = ds.readable.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > cap) {
          await reader.cancel().catch(() => {});
          return null;
        }
        parts.push(value);
      }
    }
    await writing;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.byteLength;
    }
    return out;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────
// Structural scanning
// ─────────────────────────────────────────

function isWordByte(b: number): boolean {
  return (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x5f;
}

/** True when the ASCII keyword starts a whole token at `i` (delimiter-bounded). */
function keywordAt(bytes: Uint8Array, i: number, kw: string, bound: number): boolean {
  if (i < 0 || i + kw.length > bound) return false;
  for (let k = 0; k < kw.length; k++) {
    if (bytes[i + k] !== kw.charCodeAt(k)) return false;
  }
  if (i + kw.length < bytes.length && isWordByte(bytes[i + kw.length])) return false;
  if (i > 0) {
    const p = bytes[i - 1];
    if (isWordByte(p) || p === 0x2f /* / */ || p === 0x25 /* % */) return false;
  }
  return true;
}

/** Skip a literal string starting at `(`; returns the index after the close. */
function skipString(bytes: Uint8Array, i: number, bound: number): number {
  let nest = 1;
  i++;
  while (i < bound && nest > 0) {
    const b = bytes[i];
    if (b === 0x5c) i += 2;
    else {
      if (b === 0x28) nest++;
      else if (b === 0x29) nest--;
      i++;
    }
  }
  return i;
}

/** Skip a `%` comment; returns the index after the EOL. */
function skipComment(bytes: Uint8Array, i: number, bound: number): number {
  while (i < bound && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
  return i;
}

/**
 * Advance over one token run, tracking `<<`/`>>` depth. Returns the new index
 * or -1 at the bound. Handles literal strings and comments so keywords inside
 * them never leak into the structural scan.
 */
function scanStep(bytes: Uint8Array, i: number, bound: number, depth: number): { i: number; depth: number } {
  const c = bytes[i];
  if (c === 0x28) return { i: skipString(bytes, i, bound), depth };
  if (c === 0x25) return { i: skipComment(bytes, i, bound), depth };
  if (c === 0x3c && bytes[i + 1] === 0x3c) return { i: i + 2, depth: depth + 1 };
  if (c === 0x3e && bytes[i + 1] === 0x3e) return { i: i + 2, depth: Math.max(0, depth - 1) };
  return { i: i + 1, depth };
}

interface ScannedObject {
  num: number;
  gen: number;
  start: number;
  /** byte offset just after `endobj`. */
  end: number;
}

/**
 * Scan one indirect object's full extent (`N G obj … endobj`), skipping stream
 * payloads by declared `/Length` (fast path, verified) or by a validated
 * `endstream`+`endobj` search (binary data may contain the bytes "endstream",
 * so a candidate only counts when `endobj` follows it).
 */
function scanObject(bytes: Uint8Array, start: number, bound: number, expectedNum: number): ScannedObject | null {
  const head = binOf(bytes, start, Math.min(bound, start + 64));
  const m = /^\s*(\d+)\s+(\d+)\s+obj\b/.exec(head);
  if (!m || Number(m[1]) !== expectedNum) return null;
  let i = start + m[0].length;
  let depth = 0;
  while (i < bound) {
    if (depth === 0 && keywordAt(bytes, i, "stream", bound) && (bytes[i + 6] === 0x0a || bytes[i + 6] === 0x0d)) {
      const after = skipStream(bytes, start, i, bound);
      if (after === -1) return null;
      i = after;
      continue;
    }
    if (depth === 0 && keywordAt(bytes, i, "endobj", bound)) {
      return { num: Number(m[1]), gen: Number(m[2]), start, end: i + 6 };
    }
    const step = scanStep(bytes, i, bound, depth);
    if (step.i === i) i++;
    else {
      i = step.i;
      depth = step.depth;
    }
  }
  return null;
}

/** Index after the `endstream` of the stream whose keyword starts at `i`. */
function skipStream(bytes: Uint8Array, objStart: number, i: number, bound: number): number {
  const dataStart = i + 6 + (bytes[i + 6] === 0x0d && bytes[i + 7] === 0x0a ? 2 : 1);
  const dictBin = binOf(bytes, objStart, i);
  const lenM = /\/Length\s+(\d+)(?!\s*\d+\s+R)/.exec(dictBin);
  if (lenM) {
    const cand = dataStart + Number(lenM[1]);
    // The EOL before `endstream` is not part of /Length: accept up to two.
    for (let shift = 0; shift <= 2; shift++) {
      if (keywordAt(bytes, cand + shift, "endstream", bound)) return cand + shift + 9;
    }
  }
  let pos = indexOfBytes(bytes, "endstream", dataStart, bound);
  while (pos !== -1) {
    let j = pos + 9;
    while (j < bound && (bytes[j] === 0x20 || bytes[j] === 0x09 || bytes[j] === 0x0a || bytes[j] === 0x0d)) j++;
    if (keywordAt(bytes, j, "endobj", bound)) return pos + 9;
    pos = indexOfBytes(bytes, "endstream", pos + 1, bound);
  }
  return -1;
}

/** The stream payload of an object span (dictionary text + data slice). */
function streamDataOf(bytes: Uint8Array, start: number, end: number): { dictBin: string; dataStart: number; dataEnd: number } | null {
  let i = start;
  let depth = 0;
  while (i < end) {
    if (depth === 0 && keywordAt(bytes, i, "stream", end) && (bytes[i + 6] === 0x0a || bytes[i + 6] === 0x0d)) {
      const dataStart = i + 6 + (bytes[i + 6] === 0x0d && bytes[i + 7] === 0x0a ? 2 : 1);
      const dictBin = binOf(bytes, start, i);
      const lenM = /\/Length\s+(\d+)(?!\s*\d+\s+R)/.exec(dictBin);
      const isEndstream = (p: number): boolean => p >= 0 && p + 9 <= end && binOf(bytes, p, p + 9) === "endstream";
      if (lenM) {
        const cand = dataStart + Number(lenM[1]);
        // The EOL before `endstream` is not part of /Length: accept up to two.
        if (isEndstream(cand) || isEndstream(cand + 1) || isEndstream(cand + 2)) {
          return { dictBin, dataStart, dataEnd: cand };
        }
      }
      const pos = indexOfBytes(bytes, "endstream", dataStart, end);
      if (pos === -1) return null;
      return { dictBin, dataStart, dataEnd: pos };
    }
    const step = scanStep(bytes, i, end, depth);
    if (step.i === i) i++;
    else {
      i = step.i;
      depth = step.depth;
    }
  }
  return null;
}

// ─────────────────────────────────────────
// xref chain
// ─────────────────────────────────────────

interface Ref {
  num: number;
  gen: number;
}

/** type 0 = free, 1 = plain offset, 2 = compressed in an object stream. */
interface XrefEntry {
  type: 0 | 1 | 2;
  offset: number;
  gen: number;
  stmIndex: number;
}

interface TrailerBits {
  root: Ref | null;
  info: Ref | null;
  encrypt: boolean;
  prev: number | null;
  xrefStm: number | null;
}

function trailerBitsOf(dictBin: string): TrailerBits {
  const rootM = /\/Root\s+(\d+)\s+(\d+)\s+R/.exec(dictBin);
  const infoM = /\/Info\s+(\d+)\s+(\d+)\s+R/.exec(dictBin);
  const prevM = /\/Prev\s+(\d+)/.exec(dictBin);
  const xrefStmM = /\/XRefStm\s+(\d+)/.exec(dictBin);
  return {
    root: rootM ? { num: Number(rootM[1]), gen: Number(rootM[2]) } : null,
    info: infoM ? { num: Number(infoM[1]), gen: Number(infoM[2]) } : null,
    encrypt: /\/Encrypt\b/.test(dictBin),
    prev: prevM ? Number(prevM[1]) : null,
    xrefStm: xrefStmM ? Number(xrefStmM[1]) : null,
  };
}

function putOnce(map: Map<number, XrefEntry>, num: number, entry: XrefEntry): void {
  if (!map.has(num)) map.set(num, entry);
}

const FREE: Omit<XrefEntry, "offset"> = { type: 0, gen: 0, stmIndex: 0 };

/** Balanced `<< … >>` extraction from a bin string (string/comment aware). */
function dictRangeIn(bin: string, from: number): { start: number; end: number } | null {
  const start = bin.indexOf("<<", from);
  if (start === -1) return null;
  let depth = 0;
  let i = start;
  while (i < bin.length) {
    const c = bin[i];
    if (c === "(") {
      let nest = 1;
      i++;
      while (i < bin.length && nest > 0) {
        if (bin[i] === "\\") i += 2;
        else {
          if (bin[i] === "(") nest++;
          else if (bin[i] === ")") nest--;
          i++;
        }
      }
      continue;
    }
    if (c === "%") {
      const nl = bin.indexOf("\n", i);
      i = nl === -1 ? bin.length : nl + 1;
      continue;
    }
    if (c === "<" && bin[i + 1] === "<") {
      depth++;
      i += 2;
      continue;
    }
    if (c === ">" && bin[i + 1] === ">") {
      depth--;
      i += 2;
      if (depth === 0) return { start, end: i };
      continue;
    }
    i++;
  }
  return null;
}

async function parseXrefSection(
  bytes: Uint8Array,
  offset: number,
  entries: Map<number, XrefEntry>
): Promise<TrailerBits | null> {
  const probe = binOf(bytes, offset, Math.min(bytes.length, offset + 32));
  if (/^\s*xref\b/.test(probe)) return parseClassicXref(bytes, offset, entries);
  return parseXrefStream(bytes, offset, entries);
}

/**
 * Classic `xref` table + `trailer` dictionary. Entries are parsed at their
 * fixed 20-byte stride, with a tolerant regex fallback for producers that
 * emit short rows.
 */
function parseClassicXref(bytes: Uint8Array, offset: number, entries: Map<number, XrefEntry>): TrailerBits | null {
  const trailerPos = indexOfBytes(bytes, "trailer", offset, bytes.length);
  if (trailerPos === -1) return null;
  const table = binOf(bytes, offset, trailerPos);
  let p = table.indexOf("xref") + 4;
  const skipWs = (): void => {
    while (p < table.length && /\s/.test(table[p])) p++;
  };
  for (;;) {
    skipWs();
    // Some producers concatenate several `xref` sections before the trailer.
    if (table.startsWith("xref", p)) {
      p += 4;
      continue;
    }
    const sub = /^(\d+)\s+(\d+)/.exec(table.slice(p, p + 48));
    if (!sub) break;
    let start = Number(sub[1]);
    const count = Number(sub[2]);
    p += sub[0].length;
    // Consume exactly one EOL sequence after the subsection header.
    if (table[p] === "\r") p++;
    if (table[p] === "\n") p++;
    else if (table[p] === " " || table[p] === "\t") p++;
    for (let k = 0; k < count; k++, start++) {
      const strict = /^(\d{10}) (\d{5}) ([nf])/.exec(table.slice(p, p + 20));
      if (strict) {
        p += 20;
        putOnce(entries, start, strict[3] === "n"
          ? { type: 1, offset: Number(strict[1]), gen: Number(strict[2]), stmIndex: 0 }
          : { ...FREE, offset: 0 });
        continue;
      }
      const loose = /^\s*(\d{9,10})\s+(\d{5})\s+([nf])/.exec(table.slice(p, p + 40));
      if (!loose) return null;
      p += loose[0].length;
      putOnce(entries, start, loose[3] === "n"
        ? { type: 1, offset: Number(loose[1]), gen: Number(loose[2]), stmIndex: 0 }
        : { ...FREE, offset: 0 });
    }
    // Another subsection header, or the end of the table.
    const rest = table.slice(p, p + 16);
    if (!/^\s*\d/.test(rest)) break;
  }
  const dictStart = table.indexOf("<<");
  if (dictStart === -1) {
    // The trailer dictionary may start past the `trailer` keyword we cut at.
    const after = binOf(bytes, trailerPos, Math.min(bytes.length, trailerPos + 4096));
    const range = dictRangeIn(after, 0);
    if (!range) return null;
    return trailerBitsOf(after.slice(range.start, range.end));
  }
  const range = dictRangeIn(table, dictStart);
  if (!range) return null;
  return trailerBitsOf(table.slice(range.start, range.end));
}

/** PDF 1.5 cross-reference STREAM (`/Type /XRef`, Flate-encoded W-triples). */
async function parseXrefStream(bytes: Uint8Array, offset: number, entries: Map<number, XrefEntry>): Promise<TrailerBits | null> {
  const head = binOf(bytes, offset, Math.min(bytes.length, offset + 64));
  const hm = /^\s*(\d+)\s+(\d+)\s+obj\b/.exec(head);
  if (!hm) return null;
  const span = scanObject(bytes, offset, bytes.length, Number(hm[1]));
  if (!span) return null;
  const sd = streamDataOf(bytes, span.start, span.end);
  if (!sd) return null;
  const range = dictRangeIn(sd.dictBin, 0);
  if (!range) return null;
  const dict = sd.dictBin.slice(range.start, range.end);

  const wM = /\/W\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(dict);
  if (!wM) return null;
  const w = [Number(wM[1]), Number(wM[2]), Number(wM[3])];
  if (w.some((n) => n < 0 || n > 8)) return null;
  const sizeM = /\/Size\s+(\d+)/.exec(dict);
  const size = sizeM ? Number(sizeM[1]) : 0;
  const indexM = /\/Index\s*\[([\d\s]+)\]/.exec(dict);
  let subsections: [number, number][];
  if (indexM) {
    const nums = indexM[1].trim().split(/\s+/).map(Number);
    if (nums.length % 2 !== 0) return null;
    subsections = [];
    for (let i = 0; i < nums.length; i += 2) subsections.push([nums[i], nums[i + 1]]);
  } else {
    subsections = [[0, size]];
  }

  let raw = bytes.subarray(sd.dataStart, sd.dataEnd);
  const hasFilter = /\/Filter\b/.test(dict);
  const flate = /\/Filter\s*\/FlateDecode\b/.test(dict) || /\/Filter\s*\[\s*\/FlateDecode\s*\]/.test(dict);
  if (hasFilter && !flate) return null; // exotic filter combos: do not guess
  if (flate) {
    const inflated = await inflate(raw, Math.max(16 * 1024 * 1024, raw.byteLength * 100));
    if (!inflated) return null;
    raw = inflated;
  }

  const entrySize = w[0] + w[1] + w[2];
  if (entrySize === 0) return null;
  // Big-endian field at a byte position inside the entry; a zero-width field
  // defaults per spec (type → 1, value → 0).
  const field = (start: number, width: number): number => {
    let v = 0;
    for (let k = 0; k < width; k++) v = v * 256 + (raw[start + k] ?? 0);
    return v;
  };
  let pos = 0;
  for (const [startObj, count] of subsections) {
    for (let k = 0; k < count; k++) {
      const base = pos;
      pos += entrySize;
      if (base + entrySize > raw.byteLength) return null;
      const num = startObj + k;
      const t = w[0] === 0 ? 1 : field(base, w[0]);
      const f2 = field(base + w[0], w[1]);
      const f3 = field(base + w[0] + w[1], w[2]);
      if (t === 1) putOnce(entries, num, { type: 1, offset: f2, gen: f3, stmIndex: 0 });
      else if (t === 2) putOnce(entries, num, { type: 2, offset: f2, gen: 0, stmIndex: f3 });
      else putOnce(entries, num, { ...FREE, offset: 0 });
    }
  }
  return trailerBitsOf(dict);
}

// ─────────────────────────────────────────
// The rebuild
// ─────────────────────────────────────────

const INFLATE_CAP = 64 * 1024 * 1024;

function randomHexId(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Rebuild the PDF without its metadata. Returns the new bytes, or a STRING
 * naming why the file cannot be rebuilt exactly (callers keep the original
 * bytes — fail open — and log the reason: silently retaining metadata should
 * still be observable).
 */
async function rebuildPdfWithoutMetadata(bytes: Uint8Array): Promise<Uint8Array | string> {
  if (bytes.length < 64) return "file too small";

  // Header (up to 1024 bytes of leading garbage are allowed by the spec).
  const headBin = binOf(bytes, 0, Math.min(bytes.length, 1024));
  const hm = /%PDF-\d\.\d/.exec(headBin);
  if (!hm) return "no %PDF header";
  const headerLineEnd = headBin.indexOf("\n", hm.index);
  const headerLine = headBin.slice(hm.index, headerLineEnd === -1 ? undefined : headerLineEnd + 1);

  // Last startxref of the file.
  const tailBin = binOf(bytes, Math.max(0, bytes.length - 4096), bytes.length);
  let xrefOffset = -1;
  for (const m of tailBin.matchAll(/startxref\s+(\d+)/g)) xrefOffset = Number(m[1]);
  if (xrefOffset <= 0 || xrefOffset >= bytes.length) return "no usable startxref";

  // Walk the revision chain, newest first (entries are first-wins).
  const entries = new Map<number, XrefEntry>();
  const sectionOffsets = new Set<number>([xrefOffset]);
  let root: Ref | null = null;
  const infoNums = new Set<number>();
  let encrypted = false;
  let cursor: number | null = xrefOffset;
  let depth = 0;
  while (cursor !== null && depth++ < 64) {
    if (sectionOffsets.has(cursor) && depth > 1) break;
    sectionOffsets.add(cursor);
    const bits = await parseXrefSection(bytes, cursor, entries);
    if (!bits) return `xref section unparseable at ${cursor}`;
    if (bits.encrypt) encrypted = true;
    if (!root && bits.root) root = bits.root;
    if (bits.info) infoNums.add(bits.info.num);
    if (bits.xrefStm !== null && !sectionOffsets.has(bits.xrefStm)) {
      // Hybrid 1.4/1.5 file: the /XRefStm belongs to the same revision.
      sectionOffsets.add(bits.xrefStm);
      const hyb = await parseXrefSection(bytes, bits.xrefStm, entries);
      if (hyb) {
        if (hyb.encrypt) encrypted = true;
        if (!root && hyb.root) root = hyb.root;
        if (hyb.info) infoNums.add(hyb.info.num);
      }
    }
    cursor = bits.prev;
  }
  if (encrypted) return "encrypted (/Encrypt)"; // rewriting needs the key
  if (!root) return "no /Root in any trailer";
  infoNums.delete(root.num);

  // Byte extent of every plain object. Bounds come from the sorted set of
  // known structural offsets so a scan can never run into the next object.
  const bounds: number[] = [...new Set([...sectionOffsets, bytes.length])].sort((a, b) => a - b);
  const spans = new Map<number, ScannedObject>();
  for (const [num, entry] of entries) {
    if (entry.type !== 1) continue;
    if (entry.offset <= 0 || entry.offset >= bytes.length) return `bad xref offset for object ${num}`;
    let bound = bytes.length;
    for (const b of bounds) {
      if (b > entry.offset) {
        bound = b;
        break;
      }
    }
    const span = scanObject(bytes, entry.offset, bound, num);
    if (!span) return `object ${num} extent unresolvable at ${entry.offset}`;
    spans.set(num, span);
  }

  // Objects to drop: every revision's Info, the catalog's Metadata stream,
  // the xref streams and the object-stream containers (expanded below). The
  // /XRef test runs on the PARSED dictionary only — stream data may contain
  // any bytes and must never decide an object's fate.
  const drop = new Set<number>(infoNums);
  for (const [num, span] of spans) {
    const win = binOf(bytes, span.start, Math.min(span.end, span.start + 4096));
    const range = dictRangeIn(win, 0);
    if (range && /\/Type\s*\/XRef\b/.test(win.slice(range.start, range.end))) drop.add(num);
  }

  // Expand object streams into plain indirect objects (the rebuilt file uses
  // a classic xref table, which cannot address compressed objects).
  const synthetic = new Map<number, string>();
  const containers = new Set<number>();
  for (const entry of entries.values()) {
    if (entry.type === 2) containers.add(entry.offset);
  }
  for (const stmNum of containers) {
    const span = spans.get(stmNum);
    if (!span) return `object stream ${stmNum} has no plain entry`; // compressed objects whose container we cannot read
    const sd = streamDataOf(bytes, span.start, span.end);
    if (!sd) return `object stream ${stmNum} payload unlocatable`;
    const range = dictRangeIn(sd.dictBin, 0);
    if (!range) return `object stream ${stmNum} dictionary unparseable`;
    const dict = sd.dictBin.slice(range.start, range.end);
    if (/\/Type\s*\/ObjStm\b/.test(dict) === false) return `object ${stmNum} is not an ObjStm`;
    const hasFilter = /\/Filter\b/.test(dict);
    const flate = /\/Filter\s*\/FlateDecode\b/.test(dict) || /\/Filter\s*\[\s*\/FlateDecode\s*\]/.test(dict);
    if (hasFilter && !flate) return `object stream ${stmNum} uses an exotic filter`;
    const nM = /\/N\s+(\d+)/.exec(dict);
    const firstM = /\/First\s+(\d+)/.exec(dict);
    if (!nM || !firstM) return `object stream ${stmNum} lacks /N or /First`;
    const n = Number(nM[1]);
    const first = Number(firstM[1]);
    let raw = bytes.subarray(sd.dataStart, sd.dataEnd);
    if (flate) {
      const inflated = await inflate(raw, INFLATE_CAP);
      if (!inflated) return `object stream ${stmNum} failed to inflate`;
      raw = inflated;
    }
    if (first > raw.byteLength) return `object stream ${stmNum} /First beyond payload`;
    const headerNums = binOf(raw, 0, first).trim().split(/\s+/).map(Number);
    if (headerNums.length < n * 2 || headerNums.some((v) => !Number.isFinite(v))) return `object stream ${stmNum} header malformed`;
    const bodyStart = (k: number): number => first + headerNums[2 * k + 1];
    const bodyEnd = (k: number): number => (k + 1 < n ? first + headerNums[2 * k + 3] : raw.byteLength);
    const byNum = new Map<number, number>(); // object number -> slot index
    for (let k = 0; k < n; k++) byNum.set(headerNums[2 * k], k);
    for (const [num, entry] of entries) {
      if (entry.type !== 2 || entry.offset !== stmNum) continue;
      const k = byNum.get(num);
      if (k === undefined || k >= n) return `compressed object ${num} missing from stream ${stmNum}`;
      const body = binOf(raw, bodyStart(k), bodyEnd(k));
      synthetic.set(num, `${num} 0 obj\n${body.replace(/\s+$/, "")}\nendobj\n`);
    }
    drop.add(stmNum);
  }

  // The catalog: patch the /Metadata reference out.
  const rootSpan = spans.get(root.num);
  const rootSynthetic = synthetic.get(root.num);
  if (!rootSpan && !rootSynthetic) return "catalog object missing";
  let rootBin = rootSynthetic ?? binOf(bytes, rootSpan!.start, rootSpan!.end);
  const metaM = /\/Metadata\s+(\d+)\s+(\d+)\s+R/.exec(rootBin);
  if (metaM) {
    const metaNum = Number(metaM[1]);
    if (metaNum !== root.num) drop.add(metaNum);
    rootBin = rootBin.replace(/\/Metadata\s+\d+\s+\d+\s+R/, "");
  }

  // Assemble: header, binary comment, objects by number, xref, trailer.
  const kept: { num: number; gen: number; bin: string }[] = [];
  for (const [num, entry] of entries) {
    if (entry.type === 0 || drop.has(num)) continue;
    if (num === root.num) {
      kept.push({ num, gen: rootSpan?.gen ?? 0, bin: rootBin });
      continue;
    }
    const syn = synthetic.get(num);
    if (syn !== undefined) {
      kept.push({ num, gen: 0, bin: syn });
      continue;
    }
    const span = spans.get(num);
    if (!span) continue; // a type-2 entry whose container expansion covered it
    kept.push({ num, gen: span.gen, bin: binOf(bytes, span.start, span.end) + "\n" });
  }
  if (kept.length === 0 || !kept.some((o) => o.num === root.num)) return "rebuild kept no objects";
  kept.sort((a, b) => a.num - b.num);

  const parts: Uint8Array[] = [];
  let total = 0;
  const push = (b: Uint8Array): number => {
    parts.push(b);
    const at = total;
    total += b.byteLength;
    return at;
  };
  push(bytesOf(headerLine.endsWith("\n") ? headerLine : `${headerLine}\n`));
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // "%âãÏÓ\n"

  const offsets = new Map<number, { offset: number; gen: number }>();
  for (const obj of kept) {
    const offset = push(bytesOf(obj.bin));
    offsets.set(obj.num, { offset, gen: obj.gen });
    if (!obj.bin.endsWith("\n")) push(bytesOf("\n"));
  }

  const maxNum = kept[kept.length - 1].num;
  const size = maxNum + 1;
  const xrefStart = total;
  let xref = `xref\n0 ${size}\n`;
  // Entry 0 heads the free chain; every gap links to the next free number.
  const freeNext = new Map<number, number>();
  const frees: number[] = [];
  for (let i = 1; i < size; i++) {
    if (!offsets.has(i)) frees.push(i);
  }
  for (let k = 0; k < frees.length; k++) freeNext.set(frees[k], frees[k + 1] ?? 0);
  const entry = (offset: number, gen: number, kw: "n" | "f"): string =>
    `${String(offset).padStart(10, "0")} ${String(gen).padStart(5, "0")} ${kw} \n`;
  xref += entry(frees[0] ?? 0, 65535, "f");
  for (let i = 1; i < size; i++) {
    const keptEntry = offsets.get(i);
    xref += keptEntry ? entry(keptEntry.offset, keptEntry.gen, "n") : entry(freeNext.get(i) ?? 0, 0, "f");
  }
  push(bytesOf(xref));
  push(
    bytesOf(
      `trailer\n<< /Size ${size} /Root ${root.num} ${root.gen} R /ID [<${randomHexId()}> <${randomHexId()}>] >>\nstartxref\n${xrefStart}\n%%EOF\n`
    )
  );

  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/**
 * Strip a PDF's metadata (Info dictionary, XMP stream, revision history,
 * file IDs). Returns the ORIGINAL bytes whenever the file cannot be rebuilt
 * with certainty (encrypted, malformed, exotic filters) — never a damaged
 * document.
 */
export async function stripPdfMetadata(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    const rebuilt = await rebuildPdfWithoutMetadata(bytes);
    if (rebuilt instanceof Uint8Array) return rebuilt;
    console.warn(`[strip-pdf] metadata kept: ${rebuilt}`);
  } catch (err) {
    console.warn("[strip-pdf] metadata kept: rebuild failed", String(err).slice(0, 160));
  }
  return bytes;
}
