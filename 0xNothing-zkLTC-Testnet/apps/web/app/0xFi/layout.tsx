import type { Metadata } from "next";
import { PixelMist } from "@/components/PixelMist";
import { Providers } from "@/app/providers";
import { FiHeader } from "@fi/components/FiHeader";
import { ToastProvider } from "@fi/components/Toast";
import "./shared.css";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "0xFi | LitVM DeFi", template: "%s | 0xFi" },
  description: "Swap, pooled liquidity, farming, lending, borrowing, and DIA-priced synthetic assets on LitVM.",
};

export default function FiLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <Providers withToast={false}>
      <div className="fi-root">
        <PixelMist product="fi" />
        <ToastProvider>
          <div className="fi-shell">
            <FiHeader />
            <main id="fi-main" tabIndex={-1}>{children}</main>
          </div>
        </ToastProvider>
      </div>
    </Providers>
  );
}
