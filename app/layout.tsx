import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { getCloudflareContext } from "@/lib/cf";
import { InstanceTitleProvider } from "@/lib/instance-context";
import { LocaleProvider } from "@/lib/i18n";
import { CallOverlayWrapper } from "@/components/CallOverlayWrapper";
import { PwaRegister } from "@/components/PwaRegister";
import { NotificationSound } from "@/components/NotificationSound";
import { PaletteApplier } from "@/components/PaletteApplier";
import "fork-awesome/css/fork-awesome.min.css";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

// Brand and canonical URL come from the instance configuration so renamed or
// self-hosted deployments don't emit another instance's metadata (OG images,
// canonical URLs, app title).
export async function generateMetadata(): Promise<Metadata> {
  let baseUrl = "http://localhost:3000";
  let brand = "CF ActivityPub";
  try {
    const { env } = getCloudflareContext();
    if (env.INSTANCE_URL) baseUrl = env.INSTANCE_URL;
    if (env.INSTANCE_TITLE) brand = env.INSTANCE_TITLE;
  } catch { /* local next dev / build without a Cloudflare context */ }

  return {
    title: {
      default: brand,
      template: `%s · ${brand}`,
    },
    description:
      "A Mastodon-compatible ActivityPub server built for the edge — powered by Cloudflare Workers, D1, and the open web.",
    keywords: ["activitypub", "mastodon", "fediverse", "cloudflare", "social network"],
    authors: [{ name: brand }],
    creator: brand,
    metadataBase: new URL(baseUrl),
    openGraph: {
      type: "website",
      locale: "en_US",
      title: brand,
      description: "A Mastodon-compatible ActivityPub server running on Cloudflare Workers.",
      siteName: brand,
      images: [{ url: "/logo.svg", width: 120, height: 120, alt: `${brand} logo` }],
    },
    twitter: {
      card: "summary",
      title: brand,
      description: "A Mastodon-compatible ActivityPub server running on Cloudflare Workers.",
      images: ["/logo.svg"],
    },
    manifest: "/manifest.webmanifest",
    icons: { icon: "/logo.svg", shortcut: "/logo.svg", apple: "/logo.svg" },
    appleWebApp: {
      capable: true,
      statusBarStyle: "default",
      title: brand,
    },
    formatDetection: { telephone: false, email: false, address: false },
  };
}

export const viewport: Viewport = {
  themeColor: "#6366f1",
  colorScheme: "dark light",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  let instanceTitle = "CF ActivityPub";
  try {
    const { env } = getCloudflareContext();
    if (env.INSTANCE_TITLE) instanceTitle = env.INSTANCE_TITLE;
  } catch { /* local next dev / build without a Cloudflare context */ }

  return (
    <html lang="en" className={`${inter.variable} h-full`} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(() => {
  try {
    const saved = localStorage.getItem("theme");
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const theme = saved === "light" || saved === "dark" ? saved : (systemDark ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", theme);
  } catch {}
})();`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col pb-14 md:pb-0">
        <InstanceTitleProvider title={instanceTitle}>
          <LocaleProvider>
            {children}
            <CallOverlayWrapper />
            <PwaRegister />
            <NotificationSound />
            <PaletteApplier />
          </LocaleProvider>
        </InstanceTitleProvider>
      </body>
    </html>
  );
}
