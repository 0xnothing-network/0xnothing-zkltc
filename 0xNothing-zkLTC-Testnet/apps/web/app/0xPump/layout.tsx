import { Providers } from "@/app/providers";
import { LazyPixelMist } from "@/components/LazyPixelMist";
import { PumpHeader } from "@/features/pump/components/PumpHeader";
import "./globals.css";

export default function PumpLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <div className="pump-shell">
        <LazyPixelMist product="pump" />
        <div className="pump-surface">
          <PumpHeader />
          {children}
        </div>
      </div>
    </Providers>
  );
}
