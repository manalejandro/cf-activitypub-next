import type { R2PutOptions } from "@cloudflare/workers-types";
import { metadataStripKind, stripMetadataBytes } from "@/lib/media/strip-metadata";

/**
 * Structural bucket type: the generated Worker `env` and the `@cloudflare/
 * workers-types` package are different type universes, but only `put` is used.
 */
interface MediaR2Like {
  put(key: string, value: ArrayBuffer | Uint8Array, options?: object): Promise<unknown>;
}

function contentTypeOf(options: R2PutOptions): string {
  const http = options.httpMetadata as { contentType?: string; get?: (name: string) => string | null } | undefined;
  if (!http) return "";
  if (typeof http.get === "function") return http.get("content-type") ?? "";
  return http.contentType ?? "";
}

/**
 * Store a media object in R2 with EXIF/XMP/IPTC/ID3 metadata stripped, the way
 * Mastodon processes every attachment it stores (uploads, avatars, headers and
 * the federated media cache). Image files are rewritten losslessly (shorter);
 * MP4/MOV/MP3 are cleaned in place so their byte length never changes.
 */
export async function putMediaObject(
  r2: MediaR2Like,
  key: string,
  bytes: ArrayBuffer | Uint8Array,
  options: R2PutOptions = {}
): Promise<void> {
  let body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const contentType = contentTypeOf(options);
  if (metadataStripKind(contentType)) {
    body = await stripMetadataBytes(body, contentType);
  }
  await r2.put(key, body, options);
}
