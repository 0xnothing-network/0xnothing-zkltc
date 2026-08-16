import { PixelMist } from "@/components/PixelMist";
import { PumpHeader } from "@/features/pump/components/PumpHeader";

export default function PumpLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="pump-shell">
      <PixelMist product="pump" />
      <div className="pump-surface">
        <PumpHeader />
        {children}
      </div>
    </div>
  );
}
