import type { Metadata } from "next";
import { PixelMist } from "@/components/PixelMist";
import { Providers } from "@/app/providers";
import { ToastProvider } from "@fi/components/Toast";
import { NusdHeader } from "@/features/nusd/components/NusdHeader";
// NUSD is built from the 0xFi Earn surface and the 0xPump mint panels.
import "../0xFi/globals.css";
import "../0xPump/globals.css";
import "./nusd.css";

export const metadata: Metadata = {
  title: { default: "NUSD | 0xNothing", template: "%s | NUSD" },
  description: "Mint and redeem NUSD against the zkLTC reserve, and stake it for streaming rewards and 0xPoints.",
};

export default function NusdLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <Providers>
      <div className="fi-root nusd-product">
        <PixelMist product="nusd" />
        <ToastProvider>
          <div className="fi-shell">
            <NusdHeader />
            <main id="fi-main" tabIndex={-1}>{children}</main>
          </div>
        </ToastProvider>
      </div>
    </Providers>
  );
}
