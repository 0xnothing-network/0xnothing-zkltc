import { PumpHeader } from "@/features/pump/components/PumpHeader";

export default function PumpLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="pump-shell">
      <PumpHeader />
      {children}
    </div>
  );
}
