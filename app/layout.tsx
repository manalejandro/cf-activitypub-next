import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { LocaleProvider } from "@/lib/i18n";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "CF ActivityPub",
    template: "%s · CF ActivityPub",
  },
  description:
    "A Mastodon-compatible ActivityPub server built for the edge — powered by Cloudflare Workers, D1, and the open web.",
  keywords: ["activitypub", "mastodon", "fediverse", "cloudflare", "social network"],
  authors: [{ name: "CF ActivityPub" }],
  creator: "CF ActivityPub",
  metadataBase: new URL("https://github.com/manalejandro/cf-activitypub-next"),
  openGraph: {
    type: "website",
    locale: "en_US",
    title: "CF ActivityPub",
    description: "A Mastodon-compatible ActivityPub server running on Cloudflare Workers.",
    siteName: "CF ActivityPub",
    images: [{ url: "/logo.svg", width: 120, height: 120, alt: "CF ActivityPub logo" }],
  },
  twitter: {
    card: "summary",
    title: "CF ActivityPub",
    description: "A Mastodon-compatible ActivityPub server running on Cloudflare Workers.",
    images: ["/logo.svg"],
  },
  manifest: "/manifest.json",
  icons: { icon: "/logo.svg", shortcut: "/logo.svg", apple: "/logo.svg" },
};

export const viewport: Viewport = {
  themeColor: "#6366f1",
  colorScheme: "dark light",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} h-full`}>
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
        <LocaleProvider>{children}</LocaleProvider>
      </body>
    </html>
  );
}
