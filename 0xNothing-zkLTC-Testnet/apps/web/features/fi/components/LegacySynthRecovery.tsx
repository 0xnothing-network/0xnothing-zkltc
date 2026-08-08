"use client";

import { zeroAddress, type Address } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { useToast } from "@fi/components/Toast";
import { PanelHeading, TransactionStatus } from "@fi/components/UiStates";
import { deployment } from "@fi/config/deployment";
import { legacySynthVaultAbi } from "@fi/lib/abis/synth";
import { formatAmount, formatTokenAmount } from "@fi/lib/format";
import { useProtocolTransaction } from "@fi/lib/hooks/useProtocolTransaction";

type LegacyPosition = readonly [bigint, bigint];

function LegacyVaultRow({ symbol, vault }: { symbol: "nBTC" | "nETH"; vault: Address }) {
  const { address, isConnected } = useAccount();
  const toast = useToast();
  const tx = useProtocolTransaction();
  const reads = useReadContracts({
    contracts: [
      { address: vault, abi: legacySynthVaultAbi, functionName: "positions", args: [address || zeroAddress] },
      { address: vault, abi: legacySynthVaultAbi, functionName: "mintPaused" },
      { address: vault, abi: legacySynthVaultAbi, functionName: "withdrawPaused" },
    ] as const,
    query: { enabled: Boolean(vault), refetchInterval: 15_000 },
  });
  const position = reads.data?.[0]?.result as LegacyPosition | undefined;
  const collateral = position?.[0];
  const debt = position?.[1];
  const mintPaused = reads.data?.[1]?.result as boolean | undefined;
  const withdrawPaused = reads.data?.[2]?.result as boolean | undefined;
  const canWithdraw = Boolean(
    isConnected
      && address
      && collateral
      && collateral > 0n
      && debt === 0n
      && withdrawPaused === false,
  );

  async function withdrawLegacyCollateral() {
    if (!address || !collateral || !canWithdraw) return;
    const hash = await tx.execute({
      call: {
        address: vault,
        abi: legacySynthVaultAbi,
        functionName: "withdrawCollateral",
        args: [collateral, address],
      },
    });
    if (!hash) return;
    toast.show(
      `Legacy ${symbol} collateral recovered`,
      `${formatAmount(collateral)} NUSD was returned to your wallet.`,
      "success",
    );
    void reads.refetch();
  }

  return (
    <article className="fi-legacy-recovery-row">
      <span>
        <strong>{symbol}</strong>
        <small>{vault.slice(0, 8)}…{vault.slice(-6)}</small>
      </span>
      <span>
        <small>Locked</small>
        <strong>{formatAmount(collateral)} NUSD</strong>
      </span>
      <span>
        <small>Debt</small>
        <strong>{formatTokenAmount(debt)} {symbol}</strong>
      </span>
      <div className="fi-legacy-recovery-action">
        <button
          type="button"
          className="fi-button fi-button-muted"
          disabled={!canWithdraw || tx.pending}
          onClick={() => void withdrawLegacyCollateral()}
        >
          {!isConnected
            ? "Connect wallet"
            : withdrawPaused
              ? "Withdrawal paused"
              : debt && debt > 0n
                ? "Repay debt first"
                : collateral && collateral > 0n
                  ? tx.pending ? "Recovering" : "Recover NUSD"
                  : "Nothing to recover"}
        </button>
        <TransactionStatus phase={tx.phase} message={tx.message} hash={tx.hash} />
      </div>
      {mintPaused === false ? (
        <small className="fi-inline-warning">Legacy minting has not been retired.</small>
      ) : null}
    </article>
  );
}

export function LegacySynthRecovery() {
  const vaults = [
    ["nBTC", deployment.contracts.legacyNbtcVault],
    ["nETH", deployment.contracts.legacyNethVault],
  ] as const;
  const configured = vaults.filter((entry): entry is readonly ["nBTC" | "nETH", Address] => Boolean(entry[1]));
  if (configured.length === 0) return null;

  return (
    <section className="fi-panel fi-legacy-recovery" aria-label="Legacy synth collateral recovery">
      <PanelHeading title="LEGACY COLLATERAL RECOVERY" />
      <p className="fi-panel-copy">
        Old synth markets are retired, but their debt-free NUSD collateral remains fully withdrawable.
      </p>
      <div className="fi-position-list">
        {configured.map(([symbol, vault]) => <LegacyVaultRow symbol={symbol} vault={vault} key={vault} />)}
      </div>
    </section>
  );
}
