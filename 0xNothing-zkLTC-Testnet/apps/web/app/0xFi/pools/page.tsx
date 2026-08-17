import Link from "next/link";
import { PoolDirectory } from "@fi/components/PoolDirectory";
import { PageHeading } from "@fi/components/UiStates";
import { fiPath } from "@fi/config/paths";

export default function PoolsPage() {
  return (
    <div className="fi-page fi-markets-page">
      <PageHeading
        title="Pools"
        description="Trade, provide liquidity, and inspect pool security on 0xFi."
        action={(
          <Link className="fi-button fi-button-primary" href={fiPath("/pools/create")}>
            Create Pool
          </Link>
        )}
      />
      <PoolDirectory title="" />
    </div>
  );
}
