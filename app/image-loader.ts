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
  return `${src}?w=${width}&q=${quality ?? 75}`;
}
