/**
 * Metadata stripping for cached federated media.
 *
 * Mastodon re-encodes remote media with ImageMagick/ffmpeg, which drops EXIF
 * (GPS/camera), XMP, IPTC, ID3 and `udta` metadata. A Worker cannot re-encode,
 * so this module removes the metadata **without touching the pixel/AV data**:
 *
 *  - Images (JPEG/PNG/WebP/GIF): the metadata segments/chunks are dropped
 *    (ICC colour profiles are kept, like Mastodon's `+profile "!icc,*"`).
 *    The file gets shorter, so callers must buffer these.
 *  - MP4/MOV and MP3: metadata boxes/tags are zero-filled **in place**, so the
 *    byte length never changes and the file can keep streaming straight into
 *    R2 through a TransformStream (fixed-length uploads stay valid).
 */

// ─────────────────────────────────────────
// Which media types we can clean
// ─────────────────────────────────────────

export type MetadataStripKind = "image" | "stream";

/** Whether (and how) a content type can be stripped; null = pass through. */
export function metadataStripKind(contentType: string): MetadataStripKind | null {
  const type = (contentType || "").toLowerCase();
  if (type === "image/jpeg" || type === "image/png" || type === "image/webp" || type === "image/gif") {
    return "image";
  }
  if (type === "video/mp4" || type === "video/quicktime" || type === "audio/mp4" || type === "audio/m4a"
    || type === "audio/x-m4a" || type === "audio/mpeg" || type === "audio/mp3") {
    return "stream";
  }
  return null;
}

// ─────────────────────────────────────────
// Images (length changes: callers buffer)
// ─────────────────────────────────────────

function concatParts(parts: Uint8Array[], totalLength: number): Uint8Array {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * JPEG: drop APP1 (EXIF/XMP), APP13 (IPTC/Photoshop), COM and every other APPn
 * except APP0 (JFIF), APP2 (ICC) and APP14 (Adobe colour transform). Entropy
 * data and markers after SOS are copied verbatim.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  let total = 2;
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1];
    // Standalone markers (RSTn, TEM) have no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.push(bytes.subarray(i, i + 2));
      total += 2;
      i += 2;
      continue;
    }
    if (marker === 0xda) {
      // Start of scan: copy the rest untouched.
      kept.push(bytes.subarray(i));
      total += bytes.length - i;
      i = bytes.length;
      break;
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2 || i + 2 + length > bytes.length) break;
    const isApp0 = marker === 0xe0;
    const isIcc = marker === 0xe2;
    const isAdobe = marker === 0xee;
    const isAppMarker = marker >= 0xe0 && marker <= 0xef;
    const isComment = marker === 0xfe;
    const keep = isApp0 || isIcc || isAdobe || (!isAppMarker && !isComment);
    if (keep) {
      kept.push(bytes.subarray(i, i + 2 + length));
      total += 2 + length;
    }
    i += 2 + length;
  }
  if (i < bytes.length) {
    kept.push(bytes.subarray(i));
    total += bytes.length - i;
  }
  return concatParts(kept, total);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_DROP_CHUNKS = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);

/** PNG: drop text/EXIF/time ancillary chunks (ICC `iCCP` and rendering hints stay). */
export function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 8 || PNG_SIGNATURE.some((b, idx) => bytes[idx] !== b)) return bytes;
  const kept: Uint8Array[] = [bytes.subarray(0, 8)];
  let total = 8;
  let i = 8;
  const typeOf = (offset: number) => String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  while (i + 12 <= bytes.length) {
    const length = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
    if (length > bytes.length - i - 12) break;
    const type = typeOf(i + 4);
    const chunkLength = 12 + length;
    if (!PNG_DROP_CHUNKS.has(type)) {
      kept.push(bytes.subarray(i, i + chunkLength));
      total += chunkLength;
    }
    i += chunkLength;
    if (type === "IEND") break;
  }
  if (i < bytes.length) {
    kept.push(bytes.subarray(i));
    total += bytes.length - i;
  }
  return concatParts(kept, total);
}

const WEBP_DROP_CHUNKS = new Set(["EXIF", "XMP "]);

/** WebP: drop the `EXIF` and `XMP ` RIFF chunks (ICCP is kept) and fix the RIFF size. */
export function stripWebpMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 12) return bytes;
  const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (riff !== "RIFF" || webp !== "WEBP") return bytes;
  const kept: Uint8Array[] = [];
  let total = 0;
  let i = 12;
  while (i + 8 <= bytes.length) {
    const fourcc = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
    const size = (bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24)) >>> 0;
    const chunkLength = 8 + size + (size % 2);
    if (i + chunkLength > bytes.length) break;
    if (!WEBP_DROP_CHUNKS.has(fourcc)) {
      kept.push(bytes.subarray(i, i + chunkLength));
      total += chunkLength;
    }
    i += chunkLength;
  }
  const out = new Uint8Array(12 + total);
  out.set(bytes.subarray(0, 12), 0);
  let offset = 12;
  for (const part of kept) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  // RIFF size = file length - 8, little endian.
  const riffSize = out.byteLength - 8;
  out[4] = riffSize & 0xff;
  out[5] = (riffSize >>> 8) & 0xff;
  out[6] = (riffSize >>> 16) & 0xff;
  out[7] = (riffSize >>> 24) & 0xff;
  return out;
}

/** GIF: drop comment, plain-text and non-NETSCAPE application extensions. */
export function stripGifMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 13) return bytes;
  const header = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
  if (header !== "GIF87a" && header !== "GIF89a") return bytes;
  const kept: Uint8Array[] = [bytes.subarray(0, 13)];
  let total = 13;
  const flags = bytes[10];
  let i = 13;
  if (flags & 0x80) {
    const gctSize = 3 * (1 << ((flags & 0x07) + 1));
    if (i + gctSize > bytes.length) return bytes;
    kept.push(bytes.subarray(i, i + gctSize));
    total += gctSize;
    i += gctSize;
  }
  const skipSubBlocks = (start: number): number => {
    let cursor = start;
    while (cursor < bytes.length) {
      const size = bytes[cursor];
      cursor += 1 + size;
      if (size === 0) break;
    }
    return cursor;
  };
  while (i < bytes.length) {
    const marker = bytes[i];
    if (marker === 0x3b) {
      kept.push(bytes.subarray(i, i + 1));
      total += 1;
      i += 1;
      break;
    }
    if (marker === 0x21 && i + 2 < bytes.length) {
      const label = bytes[i + 1];
      const blockStart = i;
      const payloadStart = i + 2;
      let end: number;
      if (label === 0xff) {
        // Application extension: label, block size, 11-byte identifier, then sub-blocks.
        end = skipSubBlocks(payloadStart + 1 + 11);
      } else if (label === 0x01) {
        // Plain-text extension: label, block size, 12-byte header, then sub-blocks.
        end = skipSubBlocks(payloadStart + 1 + 12);
      } else {
        end = skipSubBlocks(payloadStart);
      }
      const identifier = String.fromCharCode(...bytes.subarray(payloadStart + 1, payloadStart + 12));
      const keep = label === 0xf9 || (label === 0xff && identifier === "NETSCAPE2.0");
      if (keep) {
        kept.push(bytes.subarray(blockStart, end));
        total += end - blockStart;
      }
      i = end;
      continue;
    }
    if (marker === 0x2c && i + 10 <= bytes.length) {
      const lflags = bytes[i + 9];
      let end = i + 10;
      if (lflags & 0x80) end += 3 * (1 << ((lflags & 0x07) + 1));
      if (end + 1 > bytes.length) break;
      end += 1; // LZW minimum code size
      end = skipSubBlocks(end);
      kept.push(bytes.subarray(i, end));
      total += end - i;
      i = end;
      continue;
    }
    break;
  }
  if (i < bytes.length) {
    kept.push(bytes.subarray(i));
    total += bytes.length - i;
  }
  return concatParts(kept, total);
}

/** Strip EXIF/XMP/IPTC metadata from a buffered image (lossless, no re-encode). */
export function stripImageMetadata(bytes: Uint8Array, contentType: string): Uint8Array {
  switch ((contentType || "").toLowerCase()) {
    case "image/jpeg": return stripJpegMetadata(bytes);
    case "image/png": return stripPngMetadata(bytes);
    case "image/webp": return stripWebpMetadata(bytes);
    case "image/gif": return stripGifMetadata(bytes);
    default: return bytes;
  }
}

// ─────────────────────────────────────────
// MP4/MOV + MP3: zero-filled in place (length is preserved)
// ─────────────────────────────────────────

const XMP_UUID = new Uint8Array([0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac]);
const METADATA_LEAF_PREFIX = 0xa9; // "©"-prefixed QuickTime atoms (©xyz, ©mak, ©mod…)

function boxHeaderLength(bytes: Uint8Array, offset: number): { size: number; type: string; header: number; payload: number } | null {
  if (offset + 8 > bytes.length) return null;
  let size = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
  const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
  let header = 8;
  if (size === 1) {
    if (offset + 16 > bytes.length) return null;
    const high = ((bytes[offset + 8] << 24) | (bytes[offset + 9] << 16) | (bytes[offset + 10] << 8) | bytes[offset + 11]) >>> 0;
    const low = ((bytes[offset + 12] << 24) | (bytes[offset + 13] << 16) | (bytes[offset + 14] << 8) | bytes[offset + 15]) >>> 0;
    size = high * 2 ** 32 + low;
    header = 16;
  }
  if (size < header) return null;
  return { size, type, header, payload: size - header };
}

function zeroRange(bytes: Uint8Array, start: number, length: number): void {
  bytes.fill(0, start, start + length);
}

/** Zero `udta`/`meta`/XMP metadata inside a buffered `moov` box (in place). */
function stripMoovMetadata(bytes: Uint8Array, start: number, end: number): void {
  let offset = start;
  while (offset + 8 <= end) {
    const box = boxHeaderLength(bytes, offset);
    if (!box || offset + box.size > end) break;
    const payloadStart = offset + box.header;
    if (box.type === "udta" || box.type === "meta") {
      const childStart = box.type === "meta" ? payloadStart + 4 : payloadStart; // meta is a full box
      let child = childStart;
      while (child + 8 <= offset + box.size) {
        const inner = boxHeaderLength(bytes, child);
        if (!inner || child + inner.size > offset + box.size) break;
        const innerPayload = child + inner.header;
        if (inner.type === "ilst" || inner.type === "keys") {
          // Metadata entries: zero every child of ilst.
          let entry = innerPayload;
          while (entry + 8 <= child + inner.size) {
            const leaf = boxHeaderLength(bytes, entry);
            if (!leaf || entry + leaf.size > child + inner.size) break;
            zeroRange(bytes, entry + leaf.header, leaf.payload);
            entry += leaf.size;
          }
        } else if (inner.type === "meta") {
          stripMoovMetadata(bytes, child, child + inner.size);
        } else if (inner.type.charCodeAt(0) === METADATA_LEAF_PREFIX || inner.type === "cprt" || inner.type === "name" || inner.type === "dscp" || inner.type === "titl") {
          zeroRange(bytes, innerPayload, inner.payload);
        }
        child += inner.size;
      }
    } else if (box.type === "trak" || box.type === "mdia") {
      stripMoovMetadata(bytes, payloadStart, offset + box.size);
    } else if (box.type === "uuid") {
      const uuid = bytes.subarray(payloadStart, payloadStart + 16);
      if (uuid.length === 16 && uuid.every((b, idx) => b === XMP_UUID[idx])) {
        zeroRange(bytes, payloadStart, box.payload);
      }
    }
    offset += box.size;
  }
}

interface Mp4State {
  pending: Uint8Array;
  moov: Uint8Array | null;
  moovTarget: number;
  mode: "box" | "pass" | "blank" | "moov" | "uuid";
  remaining: number;
  uuidProbe: Uint8Array;
  /** Header of the box being passed/blanked (emitted once, before payload). */
  header: Uint8Array | null;
}

function appendToPending(state: Mp4State, chunk: Uint8Array): void {
  if (state.pending.length === 0) {
    state.pending = chunk;
    return;
  }
  const merged = new Uint8Array(state.pending.length + chunk.length);
  merged.set(state.pending, 0);
  merged.set(chunk, state.pending.length);
  state.pending = merged;
}

function nextHeader(state: Mp4State): boolean {
  if (state.pending.length < 8) return false;
  let size = ((state.pending[0] << 24) | (state.pending[1] << 16) | (state.pending[2] << 8) | state.pending[3]) >>> 0;
  const type = String.fromCharCode(state.pending[4], state.pending[5], state.pending[6], state.pending[7]);
  let header = 8;
  if (size === 1) {
    if (state.pending.length < 16) return false;
    const high = ((state.pending[8] << 24) | (state.pending[9] << 16) | (state.pending[10] << 8) | state.pending[11]) >>> 0;
    const low = ((state.pending[12] << 24) | (state.pending[13] << 16) | (state.pending[14] << 8) | state.pending[15]) >>> 0;
    size = high * 2 ** 32 + low;
    header = 16;
  }
  const headerBytes = state.pending.slice(0, header);
  const passThrough = (payload: number): boolean => {
    state.mode = "pass";
    state.remaining = payload;
    state.header = headerBytes;
    state.pending = state.pending.subarray(header);
    return true;
  };
  if (size === 0 || size < header) {
    // Box extending to EOF / malformed header: pass the rest through untouched.
    return passThrough(Infinity);
  }
  const payload = size - header;
  if (type === "moov" && payload <= 64 * 1024 * 1024) {
    state.mode = "moov";
    state.moovTarget = size;
    state.moov = new Uint8Array(size);
    state.moov.set(headerBytes, 0);
    state.pending = state.pending.subarray(header);
    state.remaining = payload;
    return true;
  }
  if (type === "udta" || type === "meta") {
    state.mode = "blank";
    state.remaining = payload;
    state.header = headerBytes;
    state.pending = state.pending.subarray(header);
    return true;
  }
  if (type === "uuid" && payload >= 16) {
    state.mode = "uuid";
    state.remaining = payload;
    state.uuidProbe = new Uint8Array(0);
    state.header = headerBytes;
    state.pending = state.pending.subarray(header);
    return true;
  }
  return passThrough(payload);
}

/** Streaming MP4/MOV cleaner: blanks metadata boxes without changing lengths. */
export function mp4MetadataStripTransform(): TransformStream<Uint8Array, Uint8Array> {
  const state: Mp4State = { pending: new Uint8Array(0), moov: null, moovTarget: 0, mode: "box", remaining: 0, uuidProbe: new Uint8Array(0), header: null };

  const process = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    for (;;) {
      if (state.mode === "box") {
        if (!nextHeader(state)) return;
        continue;
      }
      if (state.mode === "moov") {
        const available = Math.min(state.pending.length, state.remaining);
        if (available > 0) {
          state.moov!.set(state.pending.subarray(0, available), state.moovTarget - state.remaining);
          state.pending = state.pending.subarray(available);
          state.remaining -= available;
        }
        if (state.remaining > 0) return;
        const moov = state.moov!;
        stripMoovMetadata(moov, 8, moov.length);
        controller.enqueue(moov);
        state.moov = null;
        state.mode = "box";
        continue;
      }
      // Pass/blank/uuid modes: the box header goes out first, unmodified.
      if (state.header) {
        controller.enqueue(state.header);
        state.header = null;
      }
      if (state.mode === "uuid") {
        const need = Math.min(16 - state.uuidProbe.length, state.pending.length);
        if (need > 0) {
          const probe = new Uint8Array(state.uuidProbe.length + need);
          probe.set(state.uuidProbe, 0);
          probe.set(state.pending.subarray(0, need), state.uuidProbe.length);
          state.uuidProbe = probe;
          state.pending = state.pending.subarray(need);
          state.remaining -= need;
        }
        if (state.uuidProbe.length < 16) return;
        const isXmp = state.uuidProbe.every((b, idx) => b === XMP_UUID[idx]);
        if (isXmp) {
          controller.enqueue(state.uuidProbe);
          state.mode = "blank";
        } else {
          controller.enqueue(state.uuidProbe);
          state.mode = "pass";
        }
        state.uuidProbe = new Uint8Array(0);
        continue;
      }
      if (state.remaining > 0) {
        const take = Math.min(state.pending.length, state.remaining);
        if (take > 0) {
          const chunk = state.pending.subarray(0, take);
          state.pending = state.pending.subarray(take);
          state.remaining -= take;
          controller.enqueue(state.mode === "blank" ? new Uint8Array(take) : chunk);
        }
        if (state.remaining > 0) return;
      }
      state.mode = "box";
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      appendToPending(state, chunk);
      process(controller);
    },
    flush(controller) {
      if (state.pending.length > 0) {
        // Truncated/corrupt tail: keep it as-is.
        controller.enqueue(state.pending);
        state.pending = new Uint8Array(0);
      }
    },
  });
}

interface Mp3State {
  pending: Uint8Array;
  phase: "head" | "tag" | "audio";
  tagRemaining: number;
  tail: Uint8Array;
}

function synchsafe(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) | ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
}

/** Streaming MP3 cleaner: blanks ID3v2 (head) and ID3v1 (tail) tags in place. */
export function mp3MetadataStripTransform(): TransformStream<Uint8Array, Uint8Array> {
  const state: Mp3State = { pending: new Uint8Array(0), phase: "head", tagRemaining: 0, tail: new Uint8Array(0) };

  const pushTail = (controller: TransformStreamDefaultController<Uint8Array>, chunk: Uint8Array): void => {
    const merged = new Uint8Array(state.tail.length + chunk.length);
    merged.set(state.tail, 0);
    merged.set(chunk, state.tail.length);
    if (merged.length > 128) {
      controller.enqueue(merged.subarray(0, merged.length - 128));
      state.tail = merged.subarray(merged.length - 128);
    } else {
      state.tail = merged;
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const merged = new Uint8Array(state.pending.length + chunk.length);
      merged.set(state.pending, 0);
      merged.set(chunk, state.pending.length);
      state.pending = merged;

      while (state.phase !== "audio" && state.pending.length > 0) {
        if (state.phase === "head") {
          if (state.pending.length < 3) return;
          if (!(state.pending[0] === 0x49 && state.pending[1] === 0x44 && state.pending[2] === 0x33)) {
            state.phase = "audio";
            break;
          }
          if (state.pending.length < 10) return;
          const size = synchsafe(state.pending, 6);
          controller.enqueue(state.pending.subarray(0, 10)); // keep the header, blank the body
          state.pending = state.pending.subarray(10);
          state.phase = "tag";
          state.tagRemaining = size;
          continue;
        }
        // phase === "tag": blank exactly the declared tag size.
        const take = Math.min(state.pending.length, state.tagRemaining);
        if (take > 0) {
          controller.enqueue(new Uint8Array(take));
          state.pending = state.pending.subarray(take);
          state.tagRemaining -= take;
        }
        if (state.tagRemaining > 0) return;
        state.phase = "audio";
      }

      if (state.pending.length > 0) {
        pushTail(controller, state.pending);
        state.pending = new Uint8Array(0);
      }
    },
    flush(controller) {
      const tail = state.tail;
      if (tail.length > 0) {
        const isId3v1 = tail.length >= 3 && tail[0] === 0x54 && tail[1] === 0x41 && tail[2] === 0x47;
        controller.enqueue(isId3v1 ? new Uint8Array(tail.length) : tail);
      }
      state.tail = new Uint8Array(0);
    },
  });
}

/** Stripping transform for stream containers; null when unsupported. */
export function metadataStripTransform(contentType: string): TransformStream<Uint8Array, Uint8Array> | null {
  const type = (contentType || "").toLowerCase();
  if (type === "video/mp4" || type === "video/quicktime" || type === "audio/mp4" || type === "audio/m4a" || type === "audio/x-m4a") {
    return mp4MetadataStripTransform();
  }
  if (type === "audio/mpeg" || type === "audio/mp3") {
    return mp3MetadataStripTransform();
  }
  return null;
}

/**
 * Clean a buffered body. Images use the length-changing strippers; stream
 * containers go through their transform (same byte length).
 */
export async function stripMetadataBytes(bytes: Uint8Array, contentType: string): Promise<Uint8Array> {
  const kind = metadataStripKind(contentType);
  if (kind === "image") return stripImageMetadata(bytes, contentType);
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
      if (value && value.byteLength > 0) {
        parts.push(value);
        total += value.byteLength;
      }
    }
  })();
  await writer.write(bytes);
  await writer.close();
  await reading;
  return concatParts(parts, total);
}
