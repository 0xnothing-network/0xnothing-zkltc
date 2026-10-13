import type { Metadata } from "next";
import localFont from "next/font/local";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import { LITVM_RPC_URL, PUBLIC_APP_URL } from "@/lib/publicConfig";

// Silver Standard UI fonts (ui-redesign-spec §4.2). Bundled locally so builds
// never depend on Google Fonts being reachable.
const geist = localFont({
  src: "./fonts/Geist.ttf",
  variable: "--font-geist",
  weight: "100 900",
  display: "swap",
});

const geistMono = localFont({
  src: "./fonts/GeistMono.ttf",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
  preload: false,
});

// Only an explicit stored choice switches theme: legacy product CSS is still
// dark-only, so the OS preference is not applied until the restyle lands.
const themeScript = `try{var t=localStorage.getItem("0xn-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

// Every contract read leaves the browser for this origin, and the first one only
// starts after hydration. Opening the socket while the document parses removes a
// cold DNS and TLS round trip from the first on-chain number the page shows.
const rpcOrigin = new URL(LITVM_RPC_URL).origin;

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
    <html lang="en" className="dark" data-theme="dark" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <link rel="preconnect" href={rpcOrigin} crossOrigin="anonymous" />
        <link
          rel="preload"
          href="/fonts/DepartureMono-Regular.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body className={`${geist.variable} ${geistMono.variable} font-sans antialiased`}>
        <a href="#main-content" className="skip-link">Skip to content</a>
        <div id="main-content" tabIndex={-1}>{children}</div>
        {vercelAnalyticsEnabled ? <Analytics /> : null}
      </body>
    </html>
  );
}
