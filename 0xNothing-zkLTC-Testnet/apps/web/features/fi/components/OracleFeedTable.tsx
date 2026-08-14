"use client";

import { useReadContracts } from "wagmi";
import { zeroAddress } from "viem";
import { diaAggregatorAbi } from "@fi/lib/abis/dia";
import { deployment } from "@fi/config/deployment";
import { formatAmount, formatRelativeTimestamp } from "@fi/lib/format";
import { NotDeployed, PanelHeading } from "@fi/components/UiStates";

const FEEDS = [
  { key: "LTC/USD", asset: "zkLTC", address: deployment.contracts.diaLtcFeed },
  { key: "BTC/USD", asset: "nBTC", address: deployment.contracts.diaBtcFeed },
  { key: "ETH/USD", asset: "nETH", address: deployment.contracts.diaEthFeed },
] as const;

export function OracleFeedTable({ compact = false }: { compact?: boolean }) {
  const configured = FEEDS.every((feed) => Boolean(feed.address));
  const query = useReadContracts({
    contracts: FEEDS.flatMap((feed) => [
      { address: feed.address ?? zeroAddress, abi: diaAggregatorAbi, functionName: "decimals" as const, chainId: deployment.chain.id },
      { address: feed.address ?? zeroAddress, abi: diaAggregatorAbi, functionName: "latestRoundData" as const, chainId: deployment.chain.id },
    ]),
    query: { enabled: configured },
  });

  if (!configured) return <NotDeployed feature="DIA feed monitoring" />;

  const now = Math.floor(Date.now() / 1000);
  return (
    <section className={compact ? "fi-panel fi-panel-flush" : "fi-panel"}>
      <div className={compact ? "fi-table-panel-heading" : ""}>
        <PanelHeading title="Oracle prices" label="Powered by DIA" />
      </div>
      <div className="fi-table-wrap" tabIndex={0} aria-label="DIA oracle feed table">
        <table className="fi-table fi-oracle-table">
          <caption>DIA prices and freshness used for 0xFi risk checks</caption>
          <thead><tr><th>Asset</th><th>Key</th><th>Price</th><th>Updated</th><th>Status</th></tr></thead>
          <tbody>
            {FEEDS.map((feed, index) => {
              const decimalsResult = query.data?.[index * 2];
              const roundResult = query.data?.[index * 2 + 1];
              const decimals = decimalsResult?.status === "success" ? Number(decimalsResult.result) : 18;
              const tuple = roundResult?.status === "success" ? roundResult.result as readonly [bigint, bigint, bigint, bigint, bigint] : undefined;
              const value = tuple?.[1];
              const timestamp = tuple ? Number(tuple[3]) : 0;
              const complete = tuple ? tuple[4] >= tuple[0] && tuple[0] > 0n && tuple[1] > 0n : false;
              const fresh = complete && timestamp > 0 && timestamp <= now && now - timestamp <= 5_400;
              return (
                <tr key={feed.key}>
                  <td data-label="Asset">{feed.asset}</td>
                  <td className="fi-oracle-key-cell" data-label="Feed">{feed.key}</td>
                  <td data-label="Price">{value !== undefined && value > 0n ? `$${formatAmount(value, decimals, 4)}` : "--"}</td>
                  <td className="fi-oracle-updated-cell" data-label="Updated">{timestamp ? formatRelativeTimestamp(timestamp) : "--"}</td>
                  <td data-label="Status"><span className="fi-status" data-state={fresh ? "live" : "offline"}>{fresh ? "Fresh" : "Unavailable"}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
