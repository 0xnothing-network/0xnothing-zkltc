"use client";

import { useMemo, useState } from "react";
import { formatUnits, zeroAddress } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { AmountField } from "@fi/components/AmountField";
import { AssetSelect } from "@fi/components/AssetSelect";
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
  const [mode, setMode] = useState<BorrowMode>("wrap");
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
      { address: pool, abi: lendingPoolAbi, functionName: "debtBalance", args: [address || zeroAddress] },
      { address: pool, abi: lendingPoolAbi, functionName: "collateralBalance", args: [address || zeroAddress, collateralAddress || zeroAddress] },
      { address: pool, abi: lendingPoolAbi, functionName: "accountRisk", args: [address || zeroAddress] },
      { address: pool, abi: lendingPoolAbi, functionName: "maxBorrow", args: [address || zeroAddress] },
      { address: pool, abi: lendingPoolAbi, functionName: "maxWithdrawCollateral", args: [address || zeroAddress, collateralAddress || zeroAddress] },
    ] as const : [],
    query: { enabled: Boolean(pool), refetchInterval: 12_000 },
  });
  const available = reads.data?.[0]?.result as bigint | undefined;
  const debt = reads.data?.[1]?.result as bigint | undefined;
  const collateralBalance = reads.data?.[2]?.result as bigint | undefined;
  const accountRisk = reads.data?.[3]?.result as readonly [bigint, bigint, bigint, bigint, bigint, bigint] | undefined;
  const maxBorrow = reads.data?.[4]?.result as bigint | undefined;
  const maxWithdrawCollateral = reads.data?.[5]?.result as bigint | undefined;
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
  const lendingMode = mode === "deposit" || mode === "withdrawCollateral" || mode === "borrow";
  const migrationBlocked = lendingMode && !lending.ready;
  const quoteRequired = mode === "borrow" || mode === "withdrawCollateral";
  const quoteBlocked = lending.ready && quoteRequired && sourceBalance === undefined;
  const priceUnavailable = quoteBlocked && !reads.isPending;
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
      void walletNative.refetch();
      void walletWrapped.refetch();
      void walletCollateral.refetch();
      void walletNusd.refetch();
    }
  }

  return (
    <>
      <MetricStrip metrics={[
        { label: "Available NUSD", value: formatAmount(available), tone: available === 0n ? "warning" : "positive" },
        { label: "Borrow APR", value: formatPercentWad(lending.borrowRate) },
        { label: "Your debt", value: `${formatAmount(debt)} NUSD`, tone: debt && debt > 0n ? "warning" : "default" },
        { label: "Current LTV", value: debt === 0n ? "No debt" : formatBps(currentLtvBps), tone: risk.tone },
      ]} />
      <div className="fi-workspace-grid fi-workspace-balance">
        <section className="fi-panel">
          <PanelHeading title="BORROW ACCOUNT" />
          <div className="fi-preview-value"><span>Collateral</span><strong>{formatAmount(collateralBalance)} {collateral}</strong></div>
          <dl className="fi-position-list">
            <div className="fi-position-row"><span>Total value</span><strong>{formatAmount(accountRisk?.[0])} NUSD</strong></div>
            <div className="fi-position-row"><span>Debt</span><strong>{formatAmount(debt)} NUSD</strong></div>
            <div className="fi-position-row"><span>Risk</span><strong className="fi-health-value" data-state={risk.state}>{risk.label}</strong></div>
            <div className="fi-position-row"><span>LTV limits</span><strong>{selectedConfig ? `${selectedConfig[2] / 100} / ${selectedConfig[7] / 100} / ${selectedConfig[3] / 100}%` : "--"}</strong></div>
          </dl>
        </section>
        <section className="fi-panel fi-sticky-panel">
          <PanelHeading title="ACCOUNT ACTION" />
          {!configured ? <NotDeployed feature="Collateralized borrowing" /> : null}
          {pool && !lending.ready ? (
            <div className="fi-inline-state fi-inline-warning">
              <div><strong>{lending.title}</strong><span>{lending.message}</span></div>
            </div>
          ) : null}
          <div className="fi-segmented fi-segmented-six" aria-label="Borrow account action">
            {(["wrap", "deposit", "borrow", "repay", "withdrawCollateral", "unwrap"] as const).map((item) => (
              <button type="button" className={mode === item ? `active ${item === "deposit" || item === "repay" ? "positive" : item === "borrow" ? "danger" : ""}` : ""} onClick={() => changeMode(item)} key={item}>
                {item === "withdrawCollateral" ? "Withdraw" : item[0].toUpperCase() + item.slice(1)}
              </button>
            ))}
          </div>
          <div className="fi-form">
            {mode === "deposit" || mode === "withdrawCollateral" ? (
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
            ) : null}
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
            {priceUnavailable ? <div className="fi-inline-state fi-inline-warning"><div><strong>Oracle price unavailable</strong></div></div> : null}
            <button
              type="button"
              className={`fi-button fi-button-block ${mode === "borrow" || mode === "withdrawCollateral" ? "fi-button-danger" : "fi-button-primary"}`}
              disabled={!configured || migrationBlocked || quoteBlocked || !isConnected || !amount || Boolean(error) || tx.pending}
              onClick={() => void submit()}
            >
              {!configured
                ? "Not deployed"
                : migrationBlocked
                  ? lending.actionLabel
                  : quoteBlocked
                    ? reads.isPending ? "Loading limit" : "Price unavailable"
                    : !isConnected
                      ? "Connect wallet"
                      : tx.pending
                        ? "Processing"
                        : mode === "withdrawCollateral"
                          ? "Withdraw collateral"
                          : `${mode[0].toUpperCase()}${mode.slice(1)}`}
            </button>
            <TransactionStatus phase={tx.phase} message={tx.message} hash={tx.hash} />
          </div>
        </section>
      </div>
    </>
  );
}
