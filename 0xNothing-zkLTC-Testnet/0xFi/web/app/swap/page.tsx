import { PoolDirectory } from "@/components/PoolDirectory";

export default function SwapPage() {
  return (
    <div className="fi-page fi-markets-page">
      <PoolDirectory tradeOnly />
    </div>
  );
}
