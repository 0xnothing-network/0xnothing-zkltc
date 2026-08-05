"use client";

import { useMemo, useState } from "react";
import { formatUnits, zeroAddress, type Address } from "viem";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { AmountField } from "@/components/AmountField";
import { AssetSelect } from "@/components/AssetSelect";
import { MetricStrip, NotDeployed, PanelHeading, TransactionStatus } from "@/components/UiStates";
import { useToast } from "@/components/Toast";
import { assets, type AssetSymbol } from "@/config/assets";
import { deployment } from "@/config/deployment";
import { diaOracleAdapterAbi } from "@/lib/abis/dia";
import { synthSafetyReserveAbi, synthVaultAbi } from "@/lib/abis/synth";
import { formatAmount, formatTokenAmount, parseAmount } from "@/lib/format";
import { useAssetBalance } from "@/lib/hooks/useAssetBalance";
import { useProtocolTransaction } from "@/lib/hooks/useProtocolTransaction";

type SynthMode = "mint" | "topup" | "repay" | "withdraw";
type Position = readonly [bigint, bigint, bigint, bigint, bigint];
type MintQuote = readonly [bigint, bigint, boolean];

const SYNTHS = ["nBTC", "nETH"] as const;

export function SynthWorkspace() {
  const { address, isConnected } = useAccount();
  const toast = useToast();
  const [synth, setSynth] = useState<AssetSymbol>("nBTC");
  const [mode, setMode] = useState<SynthMode>("mint");
  const [amountText, setAmountText] = useState("");
  const amount = parseAmount(amountText);
  const synthAddress = assets[synth].address;
  const vault = synth === "nBTC" ? deployment.contracts.nbtcVault : deployment.contracts.nethVault;
  const oracle = synth === "nBTC" ? deployment.contracts.btcOracle : deployment.contracts.ethOracle;
  const nusdBalance = useAssetBalance("NUSD");
  const synthBalance = useAssetBalance(synth);
  const tx = useProtocolTransaction();

  const oracleState = useReadContract({
    address: oracle,
    abi: diaOracleAdapterAbi,
    functionName: "isFresh",
    query: { enabled: Boolean(oracle), refetchInterval: 15_000 },
  });
  const safetyReserveState = useReadContract({
    address: vault,
    abi: synthVaultAbi,
    functionName: "safetyReserve",
    query: { enabled: Boolean(vault), refetchInterval: 30_000 },
  });
  const safetyReserve = safetyReserveState.data && safetyReserveState.data !== zeroAddress
    ? safetyReserveState.data as Address
    : undefined;

  const reads = useReadContracts({
    contracts: vault ? [
      { address: vault, abi: synthVaultAbi, functionName: "position", args: [address || zeroAddress] },
      { address: vault, abi: synthVaultAbi, functionName: "maxMintableSynthetic", args: [address || zeroAddress] },
      { address: vault, abi: synthVaultAbi, functionName: "maxUserCollateralWithdrawable", args: [address || zeroAddress] },
      { address: vault, abi: synthVaultAbi, functionName: "mintPaused" },
      { address: vault, abi: synthVaultAbi, functionName: "withdrawPaused" },
    ] as const : [],
    query: { enabled: Boolean(vault), refetchInterval: 12_000 },
  });
  const reserveReads = useReadContracts({
    contracts: safetyReserve ? [
      { address: safetyReserve, abi: synthSafetyReserveAbi, functionName: "totalReserveNusd" },
      { address: safetyReserve, abi: synthSafetyReserveAbi, functionName: "freeReserveNusd" },
      { address: safetyReserve, abi: synthSafetyReserveAbi, functionName: "ENTRY_TVL_NUSD" },
      { address: safetyReserve, abi: synthSafetyReserveAbi, functionName: "sponsorshipActive" },
      { address: safetyReserve, abi: synthSafetyReserveAbi, functionName: "allocationsPaused" },
    ] as const : [],
    query: { enabled: Boolean(safetyReserve), refetchInterval: 12_000 },
  });

  const position = reads.data?.[0]?.result as Position | undefined;
  const maxMintable = reads.data?.[1]?.result as bigint | undefined;
  const maxWithdrawable = (reads.data?.[2]?.result as bigint | undefined) ?? position?.[4];
  const mintPaused = reads.data?.[3]?.result as boolean | undefined;
  const withdrawPaused = reads.data?.[4]?.result as boolean | undefined;

  const totalSafetyReserve = reserveReads.data?.[0]?.result as bigint | undefined;
  const freeSafetyReserve = reserveReads.data?.[1]?.result as bigint | undefined;
  const entryTvl = reserveReads.data?.[2]?.result as bigint | undefined;
  const sponsorshipActive = reserveReads.data?.[3]?.result as boolean | undefined;
  const allocationsPaused = reserveReads.data?.[4]?.result as boolean | undefined;

  const mintQuoteState = useReadContract({
    address: vault,
    abi: synthVaultAbi,
    functionName: "quoteDepositAndMint",
    args: amount && mode === "mint" ? [address || zeroAddress, amount] : undefined,
    query: {
      enabled: Boolean(vault && address && amount && mode === "mint" && oracleState.data),
      refetchInterval: 12_000,
    },
  });
  const mintQuote = mintQuoteState.data as MintQuote | undefined;
  const mintAmount = mintQuote?.[0];
  const reserveRequired = mintQuote?.[1];
  const quoteUsesSponsorship = mintQuote?.[2] === true;
  const mintFeeState = useReadContract({
    address: vault,
    abi: synthVaultAbi,
    functionName: "quoteMintFee",
    args: mintAmount && mode === "mint" ? [mintAmount] : undefined,
    query: {
      enabled: Boolean(vault && mintAmount && mode === "mint" && oracleState.data),
      refetchInterval: 12_000,
    },
  });
  const mintFee = mintFeeState.data as bigint | undefined;
  const mintDebit = amount && mintFee !== undefined ? amount + mintFee : undefined;

  const userCollateral = position?.[0];
  const reserveCollateral = position?.[1];
  const synthDebt = position?.[2];
  const positionHealth = position?.[3];
  const sourceBalance = mode === "mint" || mode === "topup"
    ? nusdBalance.data
    : mode === "repay"
      ? synthBalance.data
      : maxWithdrawable;
  const mintMaximum = nusdBalance.data === undefined ? undefined : nusdBalance.data * 10_000n / 10_010n;
  const maximumAmount = mode === "repay" && sourceBalance !== undefined && synthDebt !== undefined
    ? synthDebt < sourceBalance ? synthDebt : sourceBalance
    : mode === "mint" ? mintMaximum : sourceBalance;
  const configured = Boolean(vault && assets.NUSD.address && synthAddress && oracle);
  const mintBlocked = mode === "mint" && oracleState.data !== true;
  const withdrawBlocked = mode === "withdraw" && synthDebt !== 0n && oracleState.data !== true;
  const riskBlocked = mintBlocked || withdrawBlocked;
  const safetyProgress = useMemo(() => {
    if (totalSafetyReserve === undefined || !entryTvl) return undefined;
    const progressBps = totalSafetyReserve >= entryTvl ? 10_000n : totalSafetyReserve * 10_000n / entryTvl;
    return Number(progressBps) / 100;
  }, [entryTvl, totalSafetyReserve]);
  const healthNumber = positionHealth === undefined || positionHealth > 10n ** 30n
    ? undefined
    : Number(positionHealth) / 1e18;

  const error = useMemo(() => {
    if (!amountText) return undefined;
    if (!amount) return "Enter a valid positive amount.";
    const requiredBalance = mode === "mint" ? mintDebit : amount;
    if (sourceBalance !== undefined && requiredBalance !== undefined && requiredBalance > sourceBalance) {
      return mode === "withdraw"
        ? "Amount exceeds your withdrawable NUSD. Reserve backing cannot be withdrawn."
        : mode === "mint"
          ? "NUSD balance does not cover collateral and the 0.1% mint fee."
          : "Amount exceeds the available balance.";
    }
    if (mode === "repay" && synthDebt !== undefined && amount > synthDebt) {
      return "Repayment exceeds current synth debt.";
    }
    if (mode === "mint" && mintPaused) return "Minting is paused by governance.";
    if (mode === "mint" && mintQuoteState.isError) return "Unable to quote this mint from the DIA price.";
    if (mode === "mint" && mintFeeState.isError) return "Unable to quote the 0.1% mint fee.";
    if (mode === "mint" && mintAmount === 0n) return "This NUSD amount cannot safely mint more synth.";
    if (mode === "withdraw" && withdrawPaused) return "Collateral withdrawals are paused by governance.";
    if ((mode === "mint" || (mode === "withdraw" && synthDebt !== 0n)) && oracleState.data !== true) {
      return "DIA price is unavailable.";
    }
    return undefined;
  }, [amount, amountText, mintAmount, mintDebit, mintFeeState.isError, mintPaused, mintQuoteState.isError, mode, oracleState.data, sourceBalance, synthDebt, withdrawPaused]);

  async function submit() {
    if (!amount || !address || !synthAddress) return;
    const call = mode === "topup"
      ? { functionName: "depositCollateral", args: [amount, address] as const }
      : mode === "mint"
        ? mintAmount && mintFee !== undefined
          ? { functionName: "depositAndMint", args: [amount, mintAmount, mintFee, address] as const }
          : undefined
        : mode === "repay"
          ? { functionName: "repay", args: [amount, address] as const }
          : { functionName: "withdrawCollateral", args: [amount, address] as const };
    if (!call) return;
    const approval = mode === "topup" || mode === "mint"
      ? { token: assets.NUSD.address, spender: vault, amount: mode === "mint" ? amount + (mintFee ?? 0n) : amount }
      : mode === "repay"
        ? { token: synthAddress, spender: vault, amount }
        : undefined;
    const hash = await tx.execute({
      approval,
      call: { address: vault, abi: synthVaultAbi, functionName: call.functionName, args: call.args },
    });
    if (hash) {
      const labels: Record<SynthMode, string> = {
        mint: `${synth} minted`,
        topup: "NUSD collateral topped up",
        repay: `${synth} debt repaid`,
        withdraw: "NUSD collateral withdrawn",
      };
      const detail = mode === "mint" && mintAmount
        ? `${formatAmount(amount)} NUSD was locked, ${formatAmount(mintFee)} NUSD funded LP rewards, and ${formatTokenAmount(mintAmount)} ${synth} was received.`
        : "The isolated synth vault position was updated.";
      toast.show(labels[mode], detail, "success");
      setAmountText("");
      void reads.refetch();
      void reserveReads.refetch();
      void safetyReserveState.refetch();
      void nusdBalance.refetch();
      void synthBalance.refetch();
    }
  }

  const modeLabel = sponsorshipActive === undefined
    ? "--"
    : sponsorshipActive
      ? "1:1 sponsored"
      : "150% safety";
  const modeTone = sponsorshipActive ? "positive" : "warning";
  const safetyTvlDetail = totalSafetyReserve === undefined || entryTvl === undefined
    ? "--"
    : `${formatAmount(totalSafetyReserve, 18, 0)} / ${formatAmount(entryTvl, 18, 0)} NUSD`;

  return (
    <>
      <MetricStrip metrics={[
        { label: "Mode", value: modeLabel, tone: modeTone },
        { label: "Safety TVL", value: safetyProgress === undefined ? "--" : `${safetyProgress.toFixed(safetyProgress < 1 ? 2 : 0)}%` },
        { label: "User locked", value: `${formatAmount(userCollateral)} NUSD` },
        { label: "Reserve backing", value: `${formatAmount(reserveCollateral)} NUSD` },
        { label: "Withdrawable", value: `${formatAmount(maxWithdrawable)} NUSD` },
      ]} />
      <div className="fi-workspace-grid fi-workspace-balance">
        <section className="fi-panel">
          <PanelHeading title="SYNTH VAULT" />
          <div className="fi-preview-value">
            <span>Synth debt</span>
            <strong>{formatTokenAmount(synthDebt)} {synth}</strong>
          </div>
          <dl className="fi-position-list">
            <div className="fi-position-row"><span>Safety TVL</span><strong>{safetyTvlDetail}</strong></div>
            <div className="fi-position-row"><span>Free reserve</span><strong>{formatAmount(freeSafetyReserve)} NUSD</strong></div>
            <div className="fi-position-row"><span>Reserve allocation</span><strong>{allocationsPaused === undefined ? "--" : allocationsPaused ? "Paused" : "Open"}</strong></div>
            <div className="fi-position-row"><span>Mint headroom</span><strong>{formatTokenAmount(maxMintable)} {synth}</strong></div>
            <div className="fi-position-row"><span>Health</span><strong>{synthDebt === 0n ? "No debt" : healthNumber === undefined ? "--" : healthNumber.toFixed(2)}</strong></div>
            <div className="fi-position-row"><span>Wallet NUSD</span><strong>{formatAmount(nusdBalance.data)}</strong></div>
            <div className="fi-position-row"><span>Wallet {synth}</span><strong>{formatTokenAmount(synthBalance.data)}</strong></div>
            <div className="fi-position-row"><span>Price</span><strong>DIA {assets[synth].oracleKey}</strong></div>
          </dl>
        </section>
        <section className="fi-panel fi-sticky-panel">
          <PanelHeading title="VAULT ACTION" />
          {!configured ? <NotDeployed feature={`${synth} vault`} /> : null}
          <AssetSelect
            id="synth-asset"
            label="Isolated vault"
            value={synth}
            options={SYNTHS}
            onChange={(value) => {
              setSynth(value);
              setAmountText("");
              tx.reset();
            }}
          />
          <div className="fi-segmented fi-segmented-four" aria-label="Synthetic vault action">
            {(["mint", "topup", "repay", "withdraw"] as const).map((item) => (
              <button
                type="button"
                className={mode === item ? `active ${item === "topup" || item === "repay" ? "positive" : item === "withdraw" ? "danger" : ""}` : ""}
                onClick={() => {
                  setMode(item);
                  setAmountText("");
                  tx.reset();
                }}
                key={item}
              >
                {item === "topup" ? "Top up" : item[0].toUpperCase() + item.slice(1)}
              </button>
            ))}
          </div>
          <div className="fi-form">
            <AmountField
              id="synth-input"
              label={mode === "mint" ? "NUSD" : mode === "topup" ? "Top up" : mode === "repay" ? "Repay" : "Withdraw"}
              asset={mode === "repay" ? synth : "NUSD"}
              value={amountText}
              balance={mode === "withdraw" ? formatAmount(maxWithdrawable) : mode === "repay" ? formatTokenAmount(sourceBalance) : formatAmount(sourceBalance)}
              onChange={setAmountText}
              onMax={maximumAmount && maximumAmount > 0n ? () => setAmountText(formatUnits(maximumAmount, 18)) : undefined}
              error={error}
            />
            {mode === "mint" ? (
              <dl className="fi-form-details">
                <div><dt>Receive</dt><dd>{formatTokenAmount(mintAmount)} {synth}</dd></div>
                <div><dt>User locked</dt><dd>{formatAmount(amount)} NUSD</dd></div>
                <div><dt>LP fee (0.1%)</dt><dd>{formatAmount(mintFee)} NUSD</dd></div>
                <div><dt>Wallet debit</dt><dd>{formatAmount(mintDebit)} NUSD</dd></div>
                <div><dt>Reserve backing</dt><dd>{formatAmount(reserveRequired)} NUSD</dd></div>
                <div><dt>Funding</dt><dd>{mintQuote ? quoteUsesSponsorship ? "1:1 + reserve" : "150% safety" : "--"}</dd></div>
              </dl>
            ) : mode === "withdraw" ? (
              <dl className="fi-form-details">
                <div><dt>Your locked NUSD</dt><dd>{formatAmount(userCollateral)} NUSD</dd></div>
                <div><dt>Available to withdraw</dt><dd>{formatAmount(maxWithdrawable)} NUSD</dd></div>
              </dl>
            ) : null}
            {riskBlocked ? <div className="fi-inline-state fi-inline-warning"><div><strong>DIA price unavailable</strong></div></div> : null}
            <button
              type="button"
              className={`fi-button fi-button-block ${mode === "mint" || mode === "withdraw" ? "fi-button-danger" : "fi-button-primary"}`}
              disabled={!configured || riskBlocked || !isConnected || !amount || (mode === "mint" && (!mintAmount || mintFee === undefined)) || Boolean(error) || tx.pending}
              onClick={() => void submit()}
            >
              {!configured ? "Not deployed" : !isConnected ? "Connect wallet" : tx.pending ? "Processing" : mode === "mint" ? `Mint ${synth}` : mode === "topup" ? "Top up" : `${mode[0].toUpperCase()}${mode.slice(1)}`}
            </button>
            <TransactionStatus phase={tx.phase} message={tx.message} hash={tx.hash} />
          </div>
        </section>
      </div>
    </>
  );
}
