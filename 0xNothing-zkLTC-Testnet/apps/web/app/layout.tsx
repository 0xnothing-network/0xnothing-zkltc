import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import { Providers } from "./providers";
import { PUBLIC_APP_URL } from "@/lib/publicConfig";

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
  preload: false,
});

const vercelAnalyticsEnabled = process.env.VERCEL === "1";

export const metadata: Metadata = {
  metadataBase: new URL(PUBLIC_APP_URL),
  title: "0xNothing | Nothing to everything",
  description: "0xPixel, 0xPump, and 0xFi on LitVM Testnet.",
  openGraph: {
    title: "0xNothing | Nothing to everything",
    description: "0xPixel, 0xPump, and 0xFi on LitVM Testnet.",
    images: ["/0xNothing.jpg"],
  },
  icons: {
    icon: { url: "/favicon.svg", type: "image/svg+xml" },
    other: [
      { url: "/favicon.svg", rel: "alternate icon", type: "image/svg+xml" },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" data-scroll-behavior="smooth">
      <body className={`${jetbrainsMono.variable} font-sans antialiased`}>
        <link rel="preload" href="/fonts/DepartureMono-Regular.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <a href="#main-content" className="skip-link">Skip to content</a>
        <Providers>
          <div id="main-content">{children}</div>
        </Providers>
        {vercelAnalyticsEnabled ? <Analytics /> : null}
      </body>
    </html>
  );
}
