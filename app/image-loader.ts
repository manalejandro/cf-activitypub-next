export default function imageLoader({
  src,
  width,
  quality,
}: {
  src: string;
  width: number;
  quality?: number;
}) {
  // SVGs are vector graphics — optimization params are unnecessary and
  // break static asset serving (causes NS_BINDING_ABORTED / React #418).
  if (src.endsWith(".svg")) return src;
  // Remote URLs are served as-is: appending optimization params corrupts URLs
  // that already carry their own query string (e.g. Bluesky blob URLs with
  // `?did=…&cid=…`) and means nothing to most external CDNs.
  if (/^https?:\/\//i.test(src)) return src;
  return `${src}?w=${width}&q=${quality ?? 75}`;
}
