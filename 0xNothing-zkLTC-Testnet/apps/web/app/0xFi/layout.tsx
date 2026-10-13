import type { Metadata } from "next";
import { Providers } from "@/app/providers";
import { AppShell } from "@/components/shell/AppShell";
import { LazyPixelMist } from "@/components/LazyPixelMist";
import { ToastProvider } from "@fi/components/Toast";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "0xFi | LitVM DeFi", template: "%s | 0xFi" },
  description: "Swap, pooled liquidity, NUSD staking, lending, borrowing, and DIA-priced synthetic assets on LitVM.",
};

export default function FiLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <Providers withToast={false}>
      <div className="fi-root" data-product="fi">
        <LazyPixelMist product="fi" />
        <ToastProvider>
          <div className="fi-shell">
            <AppShell product="fi">
              <main id="fi-main" tabIndex={-1}>{children}</main>
            </AppShell>
          </div>
        </ToastProvider>
      </div>
    </Providers>
  );
}
