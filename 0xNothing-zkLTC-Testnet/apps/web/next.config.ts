import type { NextConfig } from "next";

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https: wss:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "upgrade-insecure-requests",
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
    localPatterns: [
      { pathname: "/0xNothing.jpg", search: "" },
      { pathname: "/api/pump/image" },
    ],
    remotePatterns: [
      { protocol: "https", hostname: "**.mypinata.cloud" },
      { protocol: "https", hostname: "gateway.pinata.cloud" },
      { protocol: "https", hostname: "dweb.link" },
      { protocol: "https", hostname: "**.ipfs.dweb.link" },
      { protocol: "https", hostname: "ipfs.io" },
      { protocol: "https", hostname: "**.infura.io" },
      { protocol: "https", hostname: "**.alchemy.com" },
      { protocol: "https", hostname: "**.moralis.io" },
    ],
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
