import { PixelMist } from "@/components/PixelMist";
import { Providers } from "@/app/providers";
import { PumpHeader } from "@/features/pump/components/PumpHeader";
import "./globals.css";

export default function PumpLayout({ children }: { children: React.ReactNode }) {
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
