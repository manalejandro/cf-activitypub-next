import type { NextConfig } from "next";

const cspHeader = [
  "default-src 'self'",
  // Next.js requires 'unsafe-inline' for styles and 'unsafe-eval' for its runtime.
  // 'self' is required to load _next/static chunks.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com https://challenges.cloudflare.com",
  "script-src-elem 'self' 'unsafe-inline' https://static.cloudflareinsights.com https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  // Allow images from any HTTPS source (federated content may come from remote servers)
  "img-src 'self' data: blob: https:",
  "font-src 'self'",
  // Allow connections to our own origin Google Analytics
  "connect-src 'self' https://region1.google-analytics.com https://www.google-analytics.com https://cloudflareinsights.com https://static.cloudflareinsights.com https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "media-src 'self' blob: https:",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const nextConfig: NextConfig = {
  // Required for @opennextjs/cloudflare
  outputFileTracingExcludes: {
    "*": [
      "node_modules/@swc/core-linux-x64-gnu",
      "node_modules/@swc/core-linux-x64-musl",
    ],
  },
  images: {
    loader: "custom",
    loaderFile: "./app/image-loader.ts",
  },
  experimental: {
    serverActions: {
      allowedOrigins: ["*"],
    },
  },
  // Rewrite /@username → /users/username (Mastodon profile URL convention).
  // Next.js App Router reserves @ for parallel routes so there is no app/@[username].
  // This runs after middleware; it acts as a reliable fallback for browsers.
  async rewrites() {
    return [
      { source: "/@:username", destination: "/users/:username" },
      { source: "/@:username/:path*", destination: "/users/:username" },
    ];
  },
  async headers() {
    const CORS = [
      { key: "Access-Control-Allow-Origin", value: "*" },
      { key: "Access-Control-Allow-Methods", value: "GET, POST, PUT, DELETE, OPTIONS" },
      { key: "Access-Control-Allow-Headers", value: "Content-Type, Authorization, Accept" },
    ];
    return [
      // CORS for all API, nodeinfo and well-known routes.
      // Using headers() instead of proxy NextResponse.next() avoids POST body loss.
      { source: "/api/:path*", headers: CORS },
      { source: "/nodeinfo/:path*", headers: CORS },
      { source: "/.well-known/:path*", headers: CORS },
      { source: "/oauth/:path*", headers: CORS },
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: cspHeader },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
