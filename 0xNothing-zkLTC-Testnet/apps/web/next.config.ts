import type { NextConfig } from "next";

const isDevelopment = process.env.NODE_ENV === "development";

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob: https:",
  `connect-src 'self' https: wss:${isDevelopment ? " http: ws:" : ""}`,
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  ...(isDevelopment ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  {
    key: "Permissions-Policy",
    value: "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  },
];

const nextConfig: NextConfig = {
  // Produce the minimal self-hosted server consumed by the Railway image.
  output: "standalone",
  // Escape the legacy /_next dev-chunk cache that was previously marked
  // immutable; future responses under this namespace are explicitly no-store.
  assetPrefix: process.env.NODE_ENV === "development" ? "/_0xfi-dev" : undefined,
  compress: true,
  // Keep development HMR artifacts isolated from production builds. Running
  // `next build` while the local dev server is open must never mix server HTML
  // from one compilation with client chunks from another.
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  outputFileTracingRoot: __dirname,
  experimental: {
    optimizePackageImports: [
      "wagmi",
      "viem",
      "lightweight-charts",
      "@phosphor-icons/react",
      "@tanstack/react-query",
    ],
  },
  webpack: (config) => {
    config.resolve = config.resolve || {};
    config.resolve.fallback = {
      ...(config.resolve.fallback || {}),
      "@react-native-async-storage/async-storage": false,
      "pino-pretty": false,
    };
    return config;
  },
  images: {
    formats: ["image/avif", "image/webp"],
    minimumCacheTTL: 60 * 60 * 24 * 30,
    // next/image is used only for the bundled cover art. IPFS and token logos are
    // plain <img> on purpose, so the optimizer needs no proxy entry point: every
    // remote pattern here would only widen /_next/image without serving anything.
    localPatterns: [
      { pathname: "/0xNothing.jpg", search: "" },
    ],
    remotePatterns: [],
  },
  async redirects() {
    return [
      {
        source: "/0xPump/faq",
        destination: "/0xPump/stats",
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      {
        source: "/fonts/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
      {
        source: "/favicon.svg",
        headers: [
          { key: "Cache-Control", value: "public, max-age=86400, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
