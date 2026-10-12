import dynamic from "next/dynamic";
import { Providers } from "@/app/providers";
import { PumpHeader } from "@/features/pump/components/PumpHeader";
import "./globals.css";

const PixelMist = dynamic(
  () => import("@/components/PixelMist").then((module) => module.PixelMist),
  { ssr: false },
);

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
