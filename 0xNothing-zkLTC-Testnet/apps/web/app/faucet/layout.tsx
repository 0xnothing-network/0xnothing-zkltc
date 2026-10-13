import { PixelMist } from "@/components/PixelMist";
import { Providers } from "@/app/providers";
import { PumpHeader } from "@/features/pump/components/PumpHeader";
import "../0xPump/globals.css";
import "./faucet.css";

export default function FaucetLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <div className="pump-shell">
        <PixelMist product="pump" />
        <div className="pump-surface">
          <PumpHeader />
          {children}
        </div>
      </div>
    </Providers>
  );
}
