"use client";

import { type Address } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { useToast } from "@fi/components/Toast";
import { PanelHeading, TransactionStatus } from "@fi/components/UiStates";
import { deployment } from "@fi/config/deployment";
import { legacySynthVaultAbi } from "@fi/lib/abis/synth";
import { formatAmount, formatTokenAmount } from "@fi/lib/format";
import { useProtocolTransaction } from "@fi/lib/hooks/useProtocolTransaction";

type LegacyPosition = readonly [bigint, bigint];

function LegacyVaultRow({
  address,
  onRefresh,
  position,
  positionReadFailed,
  symbol,
  vault,
}: {
  address: Address;
  onRefresh: () => void;
  position?: LegacyPosition;
  positionReadFailed: boolean;
  symbol: "nBTC" | "nETH";
  vault: Address;
}) {
  const toast = useToast();
  const tx = useProtocolTransaction();
  const reads = useReadContracts({
    contracts: [
      { address: vault, abi: legacySynthVaultAbi, functionName: "mintPaused" },
      { address: vault, abi: legacySynthVaultAbi, functionName: "withdrawPaused" },
    ] as const,
    query: { enabled: Boolean(vault), refetchInterval: 15_000 },
  });
  const collateral = position?.[0];
  const debt = position?.[1];
  const mintPaused = reads.data?.[0]?.result as boolean | undefined;
  const withdrawPaused = reads.data?.[1]?.result as boolean | undefined;
  const canWithdraw = Boolean(
    !positionReadFailed
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
    onRefresh();
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
          {positionReadFailed
            ? "Position unavailable"
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
      {positionReadFailed ? (
        <small className="fi-inline-warning">Position data could not be checked. Try again later.</small>
      ) : null}
    </article>
  );
}

export function LegacySynthRecovery() {
  const { address, isConnected } = useAccount();
  const vaults = [
    ["nBTC", deployment.contracts.legacyNbtcVault],
    ["nETH", deployment.contracts.legacyNethVault],
  ] as const;
  const configured = vaults.filter((entry): entry is readonly ["nBTC" | "nETH", Address] => Boolean(entry[1]));
  const walletReads = useReadContracts({
    contracts: address ? configured.map(([, vault]) => ({
      address: vault,
      abi: legacySynthVaultAbi,
      functionName: "positions" as const,
      args: [address] as const,
    })) : [],
    query: { enabled: Boolean(address && configured.length > 0), refetchInterval: 15_000 },
  });
  const rows = configured.map(([symbol, vault], index) => {
    const result = walletReads.data?.[index];
    const positionReadFailed = Boolean(walletReads.isError || !result || result.status === "failure");
    const position = result?.status === "success" ? result.result as LegacyPosition : undefined;
    return { position, positionReadFailed, symbol, vault };
  });
  const visibleRows = rows.filter(({ position, positionReadFailed }) => (
    positionReadFailed || Boolean(position && (position[0] > 0n || position[1] > 0n))
  ));

  if (configured.length === 0 || !isConnected || !address || walletReads.isPending) return null;
  if (visibleRows.length === 0) return null;

  return (
    <section className="fi-panel fi-legacy-recovery" aria-label="Legacy synth collateral recovery">
      <PanelHeading title="Legacy recovery" />
      <p className="fi-panel-copy">
        Recover NUSD collateral left in retired synth vaults.
      </p>
      <div className="fi-position-list">
        {visibleRows.map(({ position, positionReadFailed, symbol, vault }) => (
          <LegacyVaultRow
            address={address}
            onRefresh={() => { void walletReads.refetch(); }}
            position={position}
            positionReadFailed={positionReadFailed}
            symbol={symbol}
            vault={vault}
            key={vault}
          />
        ))}
      </div>
    </section>
  );
}
