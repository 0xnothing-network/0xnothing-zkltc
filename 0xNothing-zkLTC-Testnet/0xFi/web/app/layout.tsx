import type { Metadata } from "next";
import { FiHeader } from "@/components/FiHeader";
import { Providers } from "@/app/providers";
import { deployment } from "@/config/deployment";
import "@/app/globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(deployment.appUrl),
  title: { default: "0xFi | LitVM DeFi", template: "%s | 0xFi" },
  description: "Swap, pooled liquidity, farming, lending, borrowing, and DIA-priced synthetic assets on LitVM.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body>
        <a className="fi-skip-link" href="#fi-main">Skip to content</a>
        <Providers>
          <div className="fi-shell">
            <FiHeader />
            <main id="fi-main" tabIndex={-1}>{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
