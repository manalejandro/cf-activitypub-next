import { type NextRequest } from "next/server";
import { getInstanceTitle } from "@/lib/cf";

import en from "@/lib/locales/en.json";
import es from "@/lib/locales/es.json";
import fr from "@/lib/locales/fr.json";
import de from "@/lib/locales/de.json";
import it from "@/lib/locales/it.json";
import ja from "@/lib/locales/ja.json";
import ko from "@/lib/locales/ko.json";
import pt from "@/lib/locales/pt.json";
import ru from "@/lib/locales/ru.json";
import zhHans from "@/lib/locales/zh-Hans.json";

const LABELS: Record<string, { home: string; explore: string; notifications: string }> = {
  en: { home: en.nav_home, explore: en.nav_explore, notifications: en.nav_notifications },
  es: { home: es.nav_home, explore: es.nav_explore, notifications: es.nav_notifications },
  fr: { home: fr.nav_home, explore: fr.nav_explore, notifications: fr.nav_notifications },
  de: { home: de.nav_home, explore: de.nav_explore, notifications: de.nav_notifications },
  it: { home: it.nav_home, explore: it.nav_explore, notifications: it.nav_notifications },
  ja: { home: ja.nav_home, explore: ja.nav_explore, notifications: ja.nav_notifications },
  ko: { home: ko.nav_home, explore: ko.nav_explore, notifications: ko.nav_notifications },
  pt: { home: pt.nav_home, explore: pt.nav_explore, notifications: pt.nav_notifications },
  ru: { home: ru.nav_home, explore: ru.nav_explore, notifications: ru.nav_notifications },
  "zh-Hans": { home: zhHans.nav_home, explore: zhHans.nav_explore, notifications: zhHans.nav_notifications },
};

function pickLocale(request: NextRequest): string {
  const accept = request.headers.get("accept-language")?.toLowerCase() ?? "";
  for (const part of accept.split(",")) {
    const code = part.split(";")[0].trim();
    if (!code) continue;
    if (code.startsWith("zh")) return "zh-Hans";
    const base = code.split("-")[0];
    if (LABELS[base]) return base;
  }
  return "en";
}

// GET /manifest.webmanifest — instance-branded PWA manifest. The brand comes
// from INSTANCE_TITLE and the shortcut labels from the request language.
export async function GET(request: NextRequest): Promise<Response> {
  const brand = getInstanceTitle();
  const labels = LABELS[pickLocale(request)] ?? LABELS.en;
  const icon = [{ src: "/icons/icon-192.png", sizes: "192x192" }];

  return new Response(JSON.stringify({
    name: brand,
    short_name: brand.length <= 12 ? brand : brand.slice(0, 11) + "…",
    description: "A Mastodon-compatible ActivityPub server running on Cloudflare Workers",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0f0f17",
    theme_color: "#6366f1",
    orientation: "portrait-primary",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/logo.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
    shortcuts: [
      { name: labels.home, url: "/home", icons: icon },
      { name: labels.explore, url: "/explore", icons: icon },
      { name: labels.notifications, url: "/notifications", icons: icon },
    ],
    categories: ["social", "productivity"],
    lang: pickLocale(request),
  }), {
    headers: {
      "Content-Type": "application/manifest+json",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
