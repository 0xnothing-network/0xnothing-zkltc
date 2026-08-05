"use client";

import { useMemo, useState } from "react";
import { formatUnits, zeroAddress } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { AmountField } from "@fi/components/AmountField";
import { MetricStrip, NotDeployed, PanelHeading, TransactionStatus } from "@fi/components/UiStates";
import { useToast } from "@fi/components/Toast";
import { assets } from "@fi/config/assets";
import { deployment } from "@fi/config/deployment";
import { lendingPoolAbi } from "@fi/lib/abis/lending";
import { formatAmount, formatPercentWad, parseAmount } from "@fi/lib/format";
import { useAssetBalance } from "@fi/lib/hooks/useAssetBalance";
import { useLendingPoolStatus } from "@fi/lib/hooks/useLendingPoolStatus";
import { useProtocolTransaction } from "@fi/lib/hooks/useProtocolTransaction";

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
      { address: pool, abi: lendingPoolAbi, functionName: "supplyBalance", args: [address || zeroAddress] },
      { address: pool, abi: lendingPoolAbi, functionName: "maxWithdraw", args: [address || zeroAddress] },
    ] as const : [],
    query: { enabled: Boolean(pool), refetchInterval: 12_000 },
  });
  const totalSupplied = stats.data?.[0]?.result as bigint | undefined;
  const totalBorrowed = stats.data?.[1]?.result as bigint | undefined;
  const available = stats.data?.[2]?.result as bigint | undefined;
  const supplied = stats.data?.[3]?.result as bigint | undefined;
  const withdrawable = stats.data?.[4]?.result as bigint | undefined;
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
      setAmountText(""); void stats.refetch(); void balance.refetch();
    }
  }

  return (
    <>
      <MetricStrip metrics={[
        { label: "Total supplied", value: `${formatAmount(totalSupplied)} NUSD` },
        { label: "Total borrowed", value: `${formatAmount(totalBorrowed)} NUSD` },
        { label: "Available", value: `${formatAmount(available)} NUSD`, tone: available === 0n ? "warning" : "positive" },
        { label: "Lender APR", value: formatPercentWad(lending.lenderRate) },
        { label: "Borrow APR", value: formatPercentWad(lending.borrowRate) },
      ]} />
      <div className="fi-workspace-grid fi-workspace-balance">
        <section className="fi-panel">
          <PanelHeading title="YOUR SUPPLY" />
          <div className="fi-preview-value"><span>Current balance</span><strong>{formatAmount(supplied)} NUSD</strong></div>
          <dl className="fi-position-list">
            <div className="fi-position-row"><span>Wallet NUSD</span><strong>{formatAmount(balance.data)}</strong></div>
            <div className="fi-position-row"><span>Withdrawable</span><strong>{formatAmount(withdrawable)}</strong></div>
            <div className="fi-position-row"><span>Protocol spread</span><strong>{formatPercentWad(lending.protocolRate)}</strong></div>
          </dl>
        </section>
        <section className="fi-panel fi-sticky-panel">
          <PanelHeading title="LENDING ACTION" />
          {!pool || !assets.NUSD.address ? <NotDeployed feature="NUSD lending" /> : null}
          {pool && !lending.ready ? (
            <div className="fi-inline-state fi-inline-warning">
              <div><strong>{lending.checking ? "Verifying lending pool" : "Lending upgrade required"}</strong><span>New supply stays disabled until the fixed-rate pool is verified.</span></div>
            </div>
          ) : null}
          <div className="fi-segmented" aria-label="Lending action">
            <button type="button" className={mode === "supply" ? "active positive" : ""} onClick={() => { setMode("supply"); setAmountText(""); tx.reset(); }}>Supply</button>
            <button type="button" className={mode === "withdraw" ? "active danger" : ""} onClick={() => { setMode("withdraw"); setAmountText(""); tx.reset(); }}>Withdraw</button>
          </div>
          <div className="fi-form">
            <AmountField id="lend-amount" label={mode === "supply" ? "Supply" : "Withdraw"} asset="NUSD" value={amountText} balance={formatAmount(sourceBalance)} onChange={setAmountText} onMax={sourceBalance && sourceBalance > 0n ? () => setAmountText(formatUnits(sourceBalance, 18)) : undefined} error={error} />
            <button type="button" className={`fi-button fi-button-block ${mode === "supply" ? "fi-button-primary" : "fi-button-danger"}`} disabled={!pool || !assets.NUSD.address || riskActionBlocked || !isConnected || !amount || Boolean(error) || tx.pending} onClick={() => void submit()}>{!pool ? "Not deployed" : riskActionBlocked ? lending.checking ? "Verifying pool" : "Upgrade required" : !isConnected ? "Connect wallet" : tx.pending ? "Processing" : mode === "supply" ? "Supply NUSD" : "Withdraw NUSD"}</button>
            <TransactionStatus phase={tx.phase} message={tx.message} hash={tx.hash} />
          </div>
        </section>
      </div>
    </>
  );
}
