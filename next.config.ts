import type { NextConfig } from "next";

const cspHeader = [
  "default-src 'self'",
  // Next.js requires 'unsafe-inline' for styles and 'unsafe-eval' for its runtime.
  // 'self' is required to load _next/static chunks.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://visitas.manalejandro.com https://static.cloudflareinsights.com",
  "script-src-elem 'self' 'unsafe-inline' https://visitas.manalejandro.com https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
  // Allow images from any HTTPS source (federated content may come from remote servers)
  "img-src 'self' data: blob: https:",
  "font-src 'self'",
  // Allow connections to our own origin, the visit tracker, and Google Analytics
  "connect-src 'self' https://visitas.manalejandro.com https://region1.google-analytics.com https://www.google-analytics.com https://cloudflareinsights.com https://static.cloudflareinsights.com",
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
  async headers() {
    return [
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
