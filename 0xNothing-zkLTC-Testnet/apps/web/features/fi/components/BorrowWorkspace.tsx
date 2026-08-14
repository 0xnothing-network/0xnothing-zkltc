"use client";

import { useMemo, useState } from "react";
import { formatUnits } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { AmountField } from "@fi/components/AmountField";
import { AssetSelect } from "@fi/components/AssetSelect";
import { ConnectWalletButton } from "@fi/components/ConnectWalletButton";
import { MetricStrip, NotDeployed, PanelHeading, TransactionStatus } from "@fi/components/UiStates";
import { useToast } from "@fi/components/Toast";
import { assets } from "@fi/config/assets";
import { deployment } from "@fi/config/deployment";
import { wzkLtcAbi } from "@fi/lib/abis/dia";
import { lendingPoolAbi } from "@fi/lib/abis/lending";
import { formatAmount, formatPercentWad, parseAmount } from "@fi/lib/format";
import { useAssetBalance } from "@fi/lib/hooks/useAssetBalance";
import {
  lendingCollateralAddress,
  type LendingCollateralSymbol,
  useLendingPoolStatus,
} from "@fi/lib/hooks/useLendingPoolStatus";
import { useProtocolTransaction } from "@fi/lib/hooks/useProtocolTransaction";
import { useTokenBalance } from "@fi/lib/hooks/useTokenBalance";

type BorrowMode = "wrap" | "unwrap" | "deposit" | "withdrawCollateral" | "borrow" | "repay";
type RiskTone = "default" | "positive" | "warning" | "danger";

const COLLATERAL_ENTRIES = [
  { value: "nLTC", symbol: "nLTC", name: "Nothing Litecoin" },
  { value: "nBTC", symbol: "nBTC", name: "Nothing Bitcoin" },
  { value: "nETH", symbol: "nETH", name: "Nothing Ether" },
] as const;
const NATIVE_GAS_RESERVE_WEI = 10_000_000_000_000_000n;
const REPAY_BUFFER_SECONDS = 3_600n;
const SECONDS_PER_YEAR = 31_536_000n;
const BORROW_APR_BPS = 450n;
const BPS_DENOMINATOR = 10_000n;
const NUSD_USABLE_LIQUIDITY_FLOOR = 1_000_000_000_000n;

function boundedRepayMaximum(debt: bigint | undefined, walletBalance: bigint | undefined): bigint | undefined {
  if (debt === undefined || walletBalance === undefined) return undefined;
  if (debt === 0n || walletBalance === 0n) return 0n;
  const denominator = BPS_DENOMINATOR * SECONDS_PER_YEAR;
  const interestNumerator = debt * BORROW_APR_BPS * REPAY_BUFFER_SECONDS;
  const interestBuffer = (interestNumerator + denominator - 1n) / denominator + 2n;
  const maximumDebit = debt + interestBuffer;
  return maximumDebit < walletBalance ? maximumDebit : walletBalance;
}

function formatBps(value: bigint | undefined): string {
  if (value === undefined) return "--";
  const whole = value / 100n;
  const fraction = value % 100n;
  return fraction === 0n ? `${whole}%` : `${whole}.${fraction.toString().padStart(2, "0")}%`;
}

function ltvBpsForDebt(debt: bigint | undefined, collateralValue: bigint | undefined): bigint | undefined {
  if (debt === undefined || collateralValue === undefined) return undefined;
  if (collateralValue === 0n) return debt === 0n ? 0n : undefined;
  return (debt * BPS_DENOMINATOR + collateralValue - 1n) / collateralValue;
}

function riskState(debt: bigint | undefined, currentLtvBps: bigint | undefined): {
  label: string;
  tone: RiskTone;
  state?: "warning" | "danger";
} {
  if (debt === undefined) return { label: "--", tone: "default" };
  if (debt === 0n) return { label: "No debt", tone: "positive" };
  if (currentLtvBps === undefined) return { label: "Price unavailable", tone: "warning", state: "warning" };
  if (currentLtvBps >= 9000n) return { label: "Liquidation", tone: "danger", state: "danger" };
  if (currentLtvBps >= 8500n) return { label: "Margin call", tone: "warning", state: "warning" };
  return { label: "Safe", tone: "positive" };
}

export function BorrowWorkspace() {
  const { address, isConnected } = useAccount();
  const toast = useToast();
  const [mode, setMode] = useState<BorrowMode>("borrow");
  const [collateral, setCollateral] = useState<LendingCollateralSymbol>("nLTC");
  const [amountText, setAmountText] = useState("");
  const [repayMaxSelected, setRepayMaxSelected] = useState(false);
  const amount = parseAmount(amountText);
  const pool = deployment.contracts.lendingPool;
  const collateralAddress = lendingCollateralAddress(collateral);
  const walletNative = useAssetBalance("zkLTC");
  const walletWrapped = useTokenBalance(deployment.contracts.wzkltc);
  const walletCollateral = useTokenBalance(collateralAddress);
  const walletNusd = useAssetBalance("NUSD");
  const lending = useLendingPoolStatus();
  const tx = useProtocolTransaction();
  const reads = useReadContracts({
    contracts: pool ? [
      { address: pool, abi: lendingPoolAbi, functionName: "availableLiquidity" },
    ] as const : [],
    query: { enabled: Boolean(pool) },
  });
  const walletReads = useReadContracts({
    contracts: pool && address ? [
      { address: pool, abi: lendingPoolAbi, functionName: "debtBalance", args: [address] },
      { address: pool, abi: lendingPoolAbi, functionName: "accountRisk", args: [address] },
      { address: pool, abi: lendingPoolAbi, functionName: "maxBorrow", args: [address] },
    ] as const : [],
    query: { enabled: Boolean(pool && address) },
  });
  const collateralReads = useReadContracts({
    contracts: pool && address && collateralAddress ? [
      { address: pool, abi: lendingPoolAbi, functionName: "collateralBalance", args: [address, collateralAddress] },
      { address: pool, abi: lendingPoolAbi, functionName: "maxWithdrawCollateral", args: [address, collateralAddress] },
    ] as const : [],
    query: { enabled: Boolean(pool && address && collateralAddress) },
  });
  const available = reads.data?.[0]?.result as bigint | undefined;
  const availableIsDust = available !== undefined && available <= NUSD_USABLE_LIQUIDITY_FLOOR;
  const debt = walletReads.data?.[0]?.result as bigint | undefined;
  const accountRisk = walletReads.data?.[1]?.result as readonly [bigint, bigint, bigint, bigint, bigint, bigint] | undefined;
  const maxBorrow = walletReads.data?.[2]?.result as bigint | undefined;
  const collateralBalance = collateralReads.data?.[0]?.result as bigint | undefined;
  const maxWithdrawCollateral = collateralReads.data?.[1]?.result as bigint | undefined;
  const currentLtvBps = accountRisk?.[5];
  const selectedConfig = lending.collateralConfigs[collateral];
  const nativeSpendable = walletNative.data === undefined
    ? undefined
    : walletNative.data > NATIVE_GAS_RESERVE_WEI ? walletNative.data - NATIVE_GAS_RESERVE_WEI : 0n;
  const repayMaximum = boundedRepayMaximum(debt, walletNusd.data);
  const inputAsset = mode === "borrow" || mode === "repay"
    ? "NUSD"
    : mode === "wrap" ? "zkLTC" : mode === "unwrap" ? "nLTC" : collateral;
  const sourceBalance = mode === "wrap"
    ? nativeSpendable
    : mode === "unwrap" ? walletWrapped.data
      : mode === "deposit" ? walletCollateral.data
        : mode === "withdrawCollateral" ? maxWithdrawCollateral
          : mode === "borrow" ? maxBorrow : walletNusd.data;
  const maximumAmount = mode === "repay" ? repayMaximum : sourceBalance;
  const migrationBlocked = mode === "deposit"
    ? !lending.collateralDepositReady
    : mode === "borrow" ? !lending.borrowReady : false;
  const quoteRequired = mode === "borrow" || mode === "withdrawCollateral";
  const quoteBlocked = Boolean(address && quoteRequired && sourceBalance === undefined);
  const quoteLoading = mode === "borrow" ? walletReads.isPending : collateralReads.isPending;
  const priceUnavailable = quoteBlocked && !quoteLoading;
  const configured = mode === "wrap" || mode === "unwrap"
    ? Boolean(deployment.contracts.wzkltc)
    : mode === "repay"
      ? Boolean(pool && assets.NUSD.address)
      : Boolean(pool && assets.NUSD.address && collateralAddress);
  const risk = riskState(debt, currentLtvBps);
  const error = useMemo(() => {
    if (!amountText) return undefined;
    if (!amount) return "Enter a valid positive amount.";
    if (sourceBalance !== undefined && amount > sourceBalance) return "Amount exceeds the available balance.";
    if (mode === "repay" && debt === 0n) return "There is no debt to repay.";
    if (mode === "repay" && debt !== undefined && amount > debt && !repayMaxSelected) {
      return "Repayment exceeds current debt.";
    }
    return undefined;
  }, [amount, amountText, debt, mode, repayMaxSelected, sourceBalance]);
  const projectedDebt = !error && amount && debt !== undefined && (mode === "borrow" || mode === "repay")
    ? mode === "borrow" ? debt + amount : amount >= debt ? 0n : debt - amount
    : undefined;
  const projectedLtvBps = ltvBpsForDebt(projectedDebt, accountRisk?.[0]);
  const projectedRisk = riskState(projectedDebt, projectedLtvBps);

  function changeMode(nextMode: BorrowMode) {
    setMode(nextMode);
    setAmountText("");
    setRepayMaxSelected(false);
    tx.reset();
  }

  function changeAmount(value: string) {
    setAmountText(value);
    setRepayMaxSelected(false);
  }

  function useMaximum() {
    if (maximumAmount === undefined || maximumAmount === 0n) return;
    setAmountText(formatUnits(maximumAmount, 18));
    setRepayMaxSelected(mode === "repay");
  }

  async function submit() {
    if (!amount || !address || migrationBlocked || quoteBlocked) return;
    if (["deposit", "withdrawCollateral"].includes(mode) && !collateralAddress) return;
    const lendingCall = mode === "deposit"
      ? { functionName: "depositCollateral", args: [collateralAddress, amount, address] as const }
      : mode === "withdrawCollateral"
        ? { functionName: "withdrawCollateral", args: [collateralAddress, amount, address] as const }
        : mode === "borrow"
          ? { functionName: "borrow", args: [amount, address] as const }
          : { functionName: "repay", args: [amount, address] as const };
    const approval = mode === "deposit"
      ? { token: collateralAddress, spender: pool, amount }
      : mode === "repay" ? { token: assets.NUSD.address, spender: pool, amount } : undefined;
    const hash = mode === "wrap"
      ? await tx.execute({ call: { address: deployment.contracts.wzkltc, abi: wzkLtcAbi, functionName: "deposit", args: [], value: amount } })
      : mode === "unwrap"
        ? await tx.execute({ call: { address: deployment.contracts.wzkltc, abi: wzkLtcAbi, functionName: "withdraw", args: [amount] } })
        : await tx.execute({ approval, call: { address: pool, abi: lendingPoolAbi, functionName: lendingCall.functionName, args: lendingCall.args } });
    if (hash) {
      const labels: Record<BorrowMode, string> = {
        wrap: "zkLTC wrapped to nLTC",
        unwrap: "nLTC unwrapped to zkLTC",
        deposit: "Collateral deposited",
        withdrawCollateral: "Collateral withdrawn",
        borrow: "NUSD borrowed",
        repay: "Debt repaid",
      };
      toast.show(labels[mode], "The lending account was updated on LitVM.", "success");
      setAmountText("");
      setRepayMaxSelected(false);
      void reads.refetch();
      void walletReads.refetch();
      void collateralReads.refetch();
      void walletNative.refetch();
      void walletWrapped.refetch();
      void walletCollateral.refetch();
      void walletNusd.refetch();
    }
  }

  return (
    <>
      <MetricStrip metrics={[
        { label: "Available NUSD", value: availableIsDust ? "Unavailable" : formatAmount(available), tone: availableIsDust ? "warning" : "positive" },
        { label: "Borrow APR", value: formatPercentWad(lending.borrowRate) },
        { label: "Max borrow", value: `${formatAmount(maxBorrow)} NUSD` },
        { label: "Current LTV", value: debt === 0n ? "No debt" : formatBps(currentLtvBps), tone: risk.tone },
      ]} />
      <div className="fi-workspace-grid fi-workspace-balance">
        <section className="fi-panel">
          <PanelHeading title="Borrow account" />
          {!isConnected ? (
            <div className="fi-inline-state">
              <div><strong>No wallet connected</strong><span>Connect to view collateral, debt, and position health.</span></div>
            </div>
          ) : (
            <>
              <div className="fi-preview-value"><span>Collateral</span><strong>{formatAmount(collateralBalance)} {collateral}</strong></div>
              <dl className="fi-position-list">
                <div className="fi-position-row"><span>Collateral value</span><strong>{formatAmount(accountRisk?.[0])} NUSD</strong></div>
                <div className="fi-position-row"><span>Debt</span><strong>{formatAmount(debt)} NUSD</strong></div>
                <div className="fi-position-row"><span>Position health</span><strong className="fi-health-value" data-state={risk.state}>{risk.label}</strong></div>
              </dl>
              <details className="fi-pool-details">
                <summary>Risk thresholds</summary>
                <dl>
                  <div><dt>Max LTV</dt><dd>{selectedConfig ? `${selectedConfig[2] / 100}%` : "--"}</dd></div>
                  <div><dt>Margin call</dt><dd>{selectedConfig ? `${selectedConfig[7] / 100}%` : "--"}</dd></div>
                  <div><dt>Liquidation</dt><dd>{selectedConfig ? `${selectedConfig[3] / 100}%` : "--"}</dd></div>
                  <div><dt>Liquidation bonus</dt><dd>{selectedConfig ? `${selectedConfig[4] / 100}%` : "--"}</dd></div>
                </dl>
              </details>
            </>
          )}
        </section>
        <section className="fi-panel fi-sticky-panel">
          <PanelHeading title="Borrow NUSD" />
          {!configured ? <NotDeployed feature="Collateralized borrowing" /> : null}
          {pool && !lending.ready ? (
            <div className="fi-inline-state fi-inline-warning">
              <div><strong>{lending.title}</strong><span>{lending.message}</span></div>
            </div>
          ) : null}
          {pool && availableIsDust ? (
            <div className="fi-inline-state fi-inline-warning" role="status">
              <div><strong>No usable NUSD liquidity</strong><span>Borrowing remains limited to the raw on-chain balance until suppliers add NUSD.</span></div>
            </div>
          ) : null}
          <div className="fi-segmented" role="group" aria-label="Debt action">
            <button type="button" className={mode === "borrow" ? "active" : ""} aria-pressed={mode === "borrow"} onClick={() => changeMode("borrow")}>Borrow</button>
            <button type="button" className={mode === "repay" ? "active" : ""} aria-pressed={mode === "repay"} onClick={() => changeMode("repay")}>Repay</button>
          </div>
          <details className="fi-settings-details">
            <summary>
              <span>Manage collateral</span>
              <strong>{mode === "deposit" ? `Deposit ${collateral}` : mode === "withdrawCollateral" ? `Withdraw ${collateral}` : collateral}</strong>
            </summary>
            <div className="fi-section-stack fi-slippage-control fi-disclosure-body">
              <AssetSelect<LendingCollateralSymbol>
                id="borrow-collateral"
                label="Collateral asset"
                value={collateral}
                entries={COLLATERAL_ENTRIES}
                onChange={(value) => {
                  setCollateral(value);
                  setAmountText("");
                  setRepayMaxSelected(false);
                }}
              />
              <div className="fi-segmented" role="group" aria-label="Collateral action">
                <button type="button" className={mode === "deposit" ? "active" : ""} aria-pressed={mode === "deposit"} onClick={() => changeMode("deposit")}>Deposit</button>
                <button type="button" className={mode === "withdrawCollateral" ? "active" : ""} aria-pressed={mode === "withdrawCollateral"} onClick={() => changeMode("withdrawCollateral")}>Withdraw</button>
              </div>
            </div>
          </details>
          <details className="fi-settings-details">
            <summary>
              <span>Prepare nLTC</span>
              <strong>{mode === "wrap" ? "Wrap zkLTC" : mode === "unwrap" ? "Unwrap nLTC" : "zkLTC ↔ nLTC"}</strong>
            </summary>
            <div className="fi-section-stack fi-slippage-control fi-disclosure-body">
              <div className="fi-segmented" role="group" aria-label="Wrapped Litecoin action">
                <button type="button" className={mode === "wrap" ? "active" : ""} aria-pressed={mode === "wrap"} onClick={() => changeMode("wrap")}>Wrap</button>
                <button type="button" className={mode === "unwrap" ? "active" : ""} aria-pressed={mode === "unwrap"} onClick={() => changeMode("unwrap")}>Unwrap</button>
              </div>
            </div>
          </details>
          <form className="fi-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <AmountField
              id="borrow-amount"
              label={mode === "wrap" ? "Wrap" : mode === "unwrap" ? "Unwrap" : mode === "deposit" ? "Deposit" : mode === "withdrawCollateral" ? "Withdraw" : mode === "borrow" ? "Borrow" : "Repay"}
              asset={inputAsset}
              value={amountText}
              balance={formatAmount(sourceBalance)}
              helper={mode === "repay" && repayMaxSelected ? "Includes up to 1 hour of interest; only current debt is spent." : undefined}
              onChange={changeAmount}
              onMax={maximumAmount && maximumAmount > 0n ? useMaximum : undefined}
              error={error}
            />
            {projectedDebt !== undefined && projectedLtvBps !== undefined ? (
              <dl className="fi-form-details" aria-label="Projected borrowing risk">
                <div><dt>LTV</dt><dd><strong>{formatBps(currentLtvBps)} → {formatBps(projectedLtvBps)}</strong></dd></div>
                <div><dt>Position</dt><dd><strong>{risk.label} → {projectedRisk.label}</strong></dd></div>
              </dl>
            ) : null}
            {priceUnavailable ? <div className="fi-inline-state fi-inline-warning"><div><strong>Oracle price unavailable</strong></div></div> : null}
            {!isConnected ? <ConnectWalletButton /> : (
              <button
                type="submit"
                className={`fi-button fi-button-block ${mode === "withdrawCollateral" || mode === "unwrap" ? "fi-button-muted" : "fi-button-primary"}`}
                disabled={!configured || migrationBlocked || quoteBlocked || !amount || Boolean(error) || tx.pending}
              >
                {!configured
                  ? "Not deployed"
                  : migrationBlocked
                    ? lending.actionLabel
                    : quoteBlocked
                      ? quoteLoading ? "Loading limit" : "Price unavailable"
                      : tx.pending
                        ? "Processing"
                        : mode === "withdrawCollateral"
                          ? "Withdraw collateral"
                          : `${mode[0].toUpperCase()}${mode.slice(1)}`}
              </button>
            )}
            <TransactionStatus phase={tx.phase} message={tx.message} hash={tx.hash} />
          </form>
        </section>
      </div>
    </>
  );
}
