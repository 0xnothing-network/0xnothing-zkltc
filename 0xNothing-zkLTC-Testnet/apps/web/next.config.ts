import type { NextConfig } from "next";

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
    || normalized === "::1"
  ) return true;

  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  return octets[0] === 0
    || octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function resolveOxFiOrigin(): string {
  const configured = (process.env.OXFI_PUBLIC_ORIGIN || process.env.OXFI_INTERNAL_ORIGIN)?.trim();
  const rawOrigin = configured || "http://127.0.0.1:3301";
  const origin = new URL(rawOrigin);
  const isVercelBuild = process.env.VERCEL === "1";

  if (origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error("0xFi origin must contain only scheme and hostname, without a path, query, or credentials");
  }
  if (isVercelBuild && (!configured || origin.protocol !== "https:" || isPrivateHostname(origin.hostname))) {
    throw new Error(
      "Set OXFI_PUBLIC_ORIGIN to the public HTTPS URL of the separate 0xFi Vercel project; localhost/private origins cannot be used by Vercel rewrites",
    );
  }

  return origin.origin;
}

const oxFiOrigin = resolveOxFiOrigin();

const nextConfig: NextConfig = {
  compress: true,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  outputFileTracingRoot: __dirname,
  experimental: {
    optimizePackageImports: [
      "wagmi",
      "viem",
      "lightweight-charts",
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
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/0xFi/:path*",
          destination: `${oxFiOrigin}/0xFi/:path*`,
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  async headers() {
    return [
      {
        source: "/_next/static/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
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
