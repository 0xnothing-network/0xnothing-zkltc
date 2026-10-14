"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useAccount, useReadContracts } from "wagmi";
import { deployment } from "@fi/config/deployment";
import { lendingPoolAbi } from "@fi/lib/abis/lending";
import { formatAmount } from "@fi/lib/format";
import { BorrowWorkspace } from "@fi/components/BorrowWorkspace";
import { LendingWorkspace } from "@fi/components/LendingWorkspace";
import { HealthFactor } from "@/components/ui/HealthFactor";
import { Tabs } from "@/components/ui/Tabs";
import { dropToLiquidation, healthFactorFromCapacity } from "@/lib/risk";

export type LendTab = "supply" | "borrow";

const TABS: ReadonlyArray<{ value: LendTab; label: string }> = [
  { value: "supply", label: "Supply NUSD" },
  { value: "borrow", label: "Borrow against collateral" },
];

export function parseLendTab(value: string | null | undefined): LendTab {
  return value === "borrow" ? "borrow" : "supply";
}

/**
 * One Lend & Borrow page (spec §5, §6.5): position summary with a numeric
 * health factor, then the existing supply and borrow workspaces as tabs. All
 * transaction logic stays in LendingWorkspace / BorrowWorkspace.
 */
export function LendBorrowDashboard() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = parseLendTab(params.get("tab"));
  const { address, isConnected } = useAccount();
  const pool = deployment.contracts.lendingPool;
  const reads = useReadContracts({
    contracts: pool && address ? [
      { chainId: deployment.chain.id, address: pool, abi: lendingPoolAbi, functionName: "supplyBalance", args: [address] },
      { chainId: deployment.chain.id, address: pool, abi: lendingPoolAbi, functionName: "debtBalance", args: [address] },
      { chainId: deployment.chain.id, address: pool, abi: lendingPoolAbi, functionName: "accountRisk", args: [address] },
    ] as const : [],
    query: { enabled: Boolean(pool && address) },
  });
  const supplied = reads.data?.[0]?.result as bigint | undefined;
  const debt = reads.data?.[1]?.result as bigint | undefined;
  const risk = reads.data?.[2]?.result as readonly [bigint, bigint, bigint, bigint, bigint, bigint] | undefined;
  const hf = healthFactorFromCapacity(risk?.[3], debt);
  const drop = dropToLiquidation(hf);
  const loading = isConnected && reads.isPending;

  const setTab = (next: LendTab) => {
    router.replace(next === "borrow" ? "/0xFi/lend?tab=borrow" : "/0xFi/lend", { scroll: false });
  };

  const stat = (label: string, value: string) => (
    <div className="bg-surface-1 p-4">
      <dt className="text-xs font-medium text-fg-3">{label}</dt>
      <dd className="mt-1 font-num tnum text-lg text-fg">{loading ? <span className="skeleton inline-block h-5 w-20 rounded-ui-xs" /> : value}</dd>
    </div>
  );

  return (
    <div className="grid gap-5">
      <section className="ui font-ui" aria-label="Your lending position">
        <div className="grid gap-px overflow-hidden rounded-ui-lg border border-line bg-line md:grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,1.4fr)]">
          <dl className="contents">
            {stat("Supplied", isConnected ? `${formatAmount(supplied)} NUSD` : "—")}
            {stat("Collateral value", isConnected ? `${formatAmount(risk?.[0])} NUSD` : "—")}
            {stat("Borrowed", isConnected ? `${formatAmount(debt)} NUSD` : "—")}
          </dl>
          <div className="bg-surface-1 p-4">
            <p className="text-xs font-medium text-fg-3">Health factor</p>
            <HealthFactor className="mt-1" value={isConnected ? hf : null} />
            <p className="mt-1.5 text-xs text-fg-3">
              {!isConnected ? "Connect a wallet to see your position."
                : hf === null ? "No debt. Borrowing is optional."
                : drop !== null && drop > 0 ? `A ${(drop * 100).toFixed(0)}% drop in collateral value would trigger liquidation.`
                : "Position is at or past the liquidation threshold."}
            </p>
          </div>
        </div>
      </section>

      <div className="ui font-ui">
        <Tabs label="Lending actions" idBase="fi-lend" value={tab} items={TABS} onChange={setTab} />
      </div>
      <div role="tabpanel" id={`fi-lend-panel-${tab}`} aria-labelledby={`fi-lend-tab-${tab}`} className="grid gap-5">
        {tab === "borrow" ? <BorrowWorkspace /> : <LendingWorkspace />}
      </div>
    </div>
  );
}
