import { RedirectView } from "./RedirectView";

// /redirect?url=… — server-rendered so the rewritten query (from middleware) is
// available even though the browser URL still shows the original /@user@domain.
export default async function RedirectPage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string | string[] }>;
}) {
  const params = await searchParams;
  const raw = params?.url;
  const target = Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
  return <RedirectView target={target} />;
}
