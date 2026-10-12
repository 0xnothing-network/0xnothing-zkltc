import { PixelMist } from "@/components/PixelMist";
import { Providers } from "@/app/providers";
import { AppShell } from "@/components/shell/AppShell";
import "./globals.css";

export default function PumpLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <div className="pump-shell" data-product="pump">
        <PixelMist product="pump" />
        <div className="pump-surface">
          <AppShell product="pump">{children}</AppShell>
        </div>
      </div>
    </Providers>
  );
}
