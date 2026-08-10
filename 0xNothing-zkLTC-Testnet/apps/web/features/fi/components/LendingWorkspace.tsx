"use client";

import { useMemo, useState } from "react";
import { formatUnits } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { AmountField } from "@fi/components/AmountField";
import { ConnectWalletButton } from "@fi/components/ConnectWalletButton";
import { MetricStrip, NotDeployed, PanelHeading, TransactionStatus } from "@fi/components/UiStates";
import { useToast } from "@fi/components/Toast";
import { assets } from "@fi/config/assets";
import { deployment } from "@fi/config/deployment";
import { lendingPoolAbi } from "@fi/lib/abis/lending";
import { formatAmount, formatPercentWad, parseAmount } from "@fi/lib/format";
import { useAssetBalance } from "@fi/lib/hooks/useAssetBalance";
import { useLendingPoolStatus } from "@fi/lib/hooks/useLendingPoolStatus";
import { useProtocolTransaction } from "@fi/lib/hooks/useProtocolTransaction";

const NUSD_USABLE_LIQUIDITY_FLOOR = 1_000_000_000_000n;

export function LendingWorkspace() {
  const { address, isConnected } = useAccount();
  const toast = useToast();
  const [mode, setMode] = useState<"supply" | "withdraw">("supply");
  const [amountText, setAmountText] = useState("");
  const amount = parseAmount(amountText);
  const balance = useAssetBalance("NUSD");
  const tx = useProtocolTransaction();
  const pool = deployment.contracts.lendingPool;
  const lending = useLendingPoolStatus();
  const riskActionBlocked = mode === "supply" && !lending.ready;
  const stats = useReadContracts({
    contracts: pool ? [
      { address: pool, abi: lendingPoolAbi, functionName: "totalSupplied" },
      { address: pool, abi: lendingPoolAbi, functionName: "totalBorrowed" },
      { address: pool, abi: lendingPoolAbi, functionName: "availableLiquidity" },
    ] as const : [],
    query: { enabled: Boolean(pool), refetchInterval: 12_000 },
  });
  const walletStats = useReadContracts({
    contracts: pool && address ? [
      { address: pool, abi: lendingPoolAbi, functionName: "supplyBalance", args: [address] },
      { address: pool, abi: lendingPoolAbi, functionName: "maxWithdraw", args: [address] },
    ] as const : [],
    query: { enabled: Boolean(pool && address), refetchInterval: 12_000 },
  });
  const totalSupplied = stats.data?.[0]?.result as bigint | undefined;
  const totalBorrowed = stats.data?.[1]?.result as bigint | undefined;
  const available = stats.data?.[2]?.result as bigint | undefined;
  const availableIsDust = available !== undefined && available <= NUSD_USABLE_LIQUIDITY_FLOOR;
  const supplied = walletStats.data?.[0]?.result as bigint | undefined;
  const withdrawable = walletStats.data?.[1]?.result as bigint | undefined;
  const sourceBalance = mode === "supply" ? balance.data : withdrawable;
  const error = useMemo(() => {
    if (!amountText) return undefined;
    if (!amount) return "Enter a valid NUSD amount.";
    if (sourceBalance !== undefined && amount > sourceBalance) return "Amount exceeds available balance.";
    return undefined;
  }, [amount, amountText, sourceBalance]);

  async function submit() {
    if (!amount || !address) return;
    const hash = await tx.execute({
      approval: mode === "supply" ? { token: assets.NUSD.address, spender: pool, amount } : undefined,
      call: {
        address: pool,
        abi: lendingPoolAbi,
        functionName: mode,
        args: mode === "supply" ? [amount, address] : [amount, address],
      },
    });
    if (hash) {
      toast.show(mode === "supply" ? "NUSD supplied" : "NUSD withdrawn", "The pooled lending position was confirmed.", "success");
      setAmountText(""); void stats.refetch(); void walletStats.refetch(); void balance.refetch();
    }
  }

  return (
    <>
      <MetricStrip metrics={[
        { label: "Total supplied", value: `${formatAmount(totalSupplied)} NUSD` },
        { label: "Total borrowed", value: `${formatAmount(totalBorrowed)} NUSD` },
        { label: "Available", value: availableIsDust ? "Unavailable" : `${formatAmount(available)} NUSD`, tone: availableIsDust ? "warning" : "positive" },
        { label: "Supply APR", value: formatPercentWad(lending.lenderRate) },
      ]} />
      <div className="fi-workspace-grid fi-workspace-balance">
        <section className="fi-panel">
          <PanelHeading title="Your supply" />
          {!isConnected ? (
            <div className="fi-inline-state">
              <div><strong>No wallet connected</strong><span>Connect to view your supplied and withdrawable NUSD.</span></div>
            </div>
          ) : (
            <>
              <div className="fi-preview-value"><span>Current balance</span><strong>{formatAmount(supplied)} NUSD</strong></div>
              <dl className="fi-position-list">
                <div className="fi-position-row"><span>Wallet NUSD</span><strong>{formatAmount(balance.data)}</strong></div>
                <div className="fi-position-row"><span>Withdrawable</span><strong>{formatAmount(withdrawable)}</strong></div>
              </dl>
            </>
          )}
        </section>
        <section className="fi-panel fi-sticky-panel">
          <PanelHeading title="NUSD market" />
          {!pool || !assets.NUSD.address ? <NotDeployed feature="NUSD lending" /> : null}
          {pool && !lending.ready ? (
            <div className="fi-inline-state fi-inline-warning">
              <div><strong>{lending.title}</strong><span>{lending.message}</span></div>
            </div>
          ) : null}
          {pool && availableIsDust ? (
            <div className="fi-inline-state fi-inline-warning" role="status">
              <div><strong>No usable NUSD liquidity</strong><span>Only a dust balance remains until more NUSD is supplied.</span></div>
            </div>
          ) : null}
          <div className="fi-segmented" role="group" aria-label="Lending action">
            <button type="button" className={mode === "supply" ? "active" : ""} aria-pressed={mode === "supply"} onClick={() => { setMode("supply"); setAmountText(""); tx.reset(); }}>Supply</button>
            <button type="button" className={mode === "withdraw" ? "active" : ""} aria-pressed={mode === "withdraw"} onClick={() => { setMode("withdraw"); setAmountText(""); tx.reset(); }}>Withdraw</button>
          </div>
          <form className="fi-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <AmountField id="lend-amount" label={mode === "supply" ? "Supply" : "Withdraw"} asset="NUSD" value={amountText} balance={formatAmount(sourceBalance)} onChange={setAmountText} onMax={sourceBalance && sourceBalance > 0n ? () => setAmountText(formatUnits(sourceBalance, 18)) : undefined} error={error} />
            {!isConnected ? <ConnectWalletButton /> : (
              <button type="submit" className={`fi-button fi-button-block ${mode === "supply" ? "fi-button-primary" : "fi-button-muted"}`} disabled={!pool || !assets.NUSD.address || riskActionBlocked || !amount || Boolean(error) || tx.pending}>{!pool ? "Not deployed" : riskActionBlocked ? lending.actionLabel : tx.pending ? "Processing" : mode === "supply" ? "Supply NUSD" : "Withdraw NUSD"}</button>
            )}
            <TransactionStatus phase={tx.phase} message={tx.message} hash={tx.hash} />
          </form>
        </section>
      </div>
    </>
  );
}
