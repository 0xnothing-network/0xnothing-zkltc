"use client";

import { useMemo, useState } from "react";
import { formatUnits, zeroAddress, type Address } from "viem";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { AmountField } from "@fi/components/AmountField";
import { AssetSelect } from "@fi/components/AssetSelect";
import { ConnectWalletButton } from "@fi/components/ConnectWalletButton";
import { MetricStrip, NotDeployed, PanelHeading, TransactionStatus } from "@fi/components/UiStates";
import { useToast } from "@fi/components/Toast";
import { assets } from "@fi/config/assets";
import { deployment } from "@fi/config/deployment";
import { diaOracleAdapterAbi } from "@fi/lib/abis/dia";
import { synthSafetyReserveAbi, synthVaultAbi } from "@fi/lib/abis/synth";
import { formatAmount, formatTokenAmount, parseAmount } from "@fi/lib/format";
import { useAssetBalance } from "@fi/lib/hooks/useAssetBalance";
import { useProtocolTransaction } from "@fi/lib/hooks/useProtocolTransaction";
import { useSynthVaultStatus } from "@fi/lib/hooks/useSynthVaultStatus";

type SynthMode = "mint" | "topup" | "repay" | "withdraw";
type Position = readonly [bigint, bigint, bigint, bigint, bigint];
type MintQuote = readonly [bigint, bigint, boolean];

const SYNTHS = ["nBTC", "nETH"] as const;
type SynthAsset = (typeof SYNTHS)[number];
const BPS_DENOMINATOR = 10_000n;
const MINT_OUTPUT_HAIRCUT_BPS = 50n;
const MINT_FEE_TOLERANCE_BPS = 100n;
// The vault fee is 10 bps. Eleven bps safely covers the bounded fee ceiling
// used by the MAX shortcut without ever approving the full wallet balance.
const MAX_MINT_FEE_RATE_BPS = 11n;

function amountAfterHaircut(value: bigint | undefined): bigint | undefined {
  return value === undefined
    ? undefined
    : value * (BPS_DENOMINATOR - MINT_OUTPUT_HAIRCUT_BPS) / BPS_DENOMINATOR;
}

function amountWithTolerance(value: bigint | undefined): bigint | undefined {
  return value === undefined
    ? undefined
    : (value * (BPS_DENOMINATOR + MINT_FEE_TOLERANCE_BPS) + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
}

export function SynthWorkspace({ initialSynth = "nBTC" }: { initialSynth?: SynthAsset } = {}) {
  const { address, isConnected } = useAccount();
  const toast = useToast();
  const [synth, setSynth] = useState<SynthAsset>(initialSynth);
  const [mode, setMode] = useState<SynthMode>("mint");
  const [amountText, setAmountText] = useState("");
  const amount = parseAmount(amountText);
  const synthAddress = assets[synth].address;
  const vault = synth === "nBTC" ? deployment.contracts.nbtcVault : deployment.contracts.nethVault;
  const oracle = synth === "nBTC" ? deployment.contracts.btcOracle : deployment.contracts.ethOracle;
  const nusdBalance = useAssetBalance("NUSD");
  const synthBalance = useAssetBalance(synth);
  const tx = useProtocolTransaction();
  const vaultStatus = useSynthVaultStatus(vault);

  const oracleState = useReadContract({
    address: oracle,
    abi: diaOracleAdapterAbi,
    functionName: "isFresh",
    query: { enabled: Boolean(oracle) },
  });
  const safetyReserveState = useReadContract({
    address: vault,
    abi: synthVaultAbi,
    functionName: "safetyReserve",
    query: { enabled: Boolean(vault) },
  });
  const safetyReserve = safetyReserveState.data && safetyReserveState.data !== zeroAddress
    ? safetyReserveState.data as Address
    : undefined;

  const reads = useReadContracts({
    contracts: vault ? [
      { address: vault, abi: synthVaultAbi, functionName: "mintPaused" },
      { address: vault, abi: synthVaultAbi, functionName: "withdrawPaused" },
    ] as const : [],
    query: { enabled: Boolean(vault) },
  });
  const walletReads = useReadContracts({
    contracts: vault && address ? [
      { address: vault, abi: synthVaultAbi, functionName: "position", args: [address] },
      { address: vault, abi: synthVaultAbi, functionName: "maxMintableSynthetic", args: [address] },
      { address: vault, abi: synthVaultAbi, functionName: "maxUserCollateralWithdrawable", args: [address] },
    ] as const : [],
    query: { enabled: Boolean(vault && address) },
  });
  const reserveReads = useReadContracts({
    contracts: safetyReserve ? [
      { address: safetyReserve, abi: synthSafetyReserveAbi, functionName: "totalReserveNusd" },
      { address: safetyReserve, abi: synthSafetyReserveAbi, functionName: "freeReserveNusd" },
      { address: safetyReserve, abi: synthSafetyReserveAbi, functionName: "ENTRY_TVL_NUSD" },
      { address: safetyReserve, abi: synthSafetyReserveAbi, functionName: "sponsorshipActive" },
      { address: safetyReserve, abi: synthSafetyReserveAbi, functionName: "allocationsPaused" },
    ] as const : [],
    query: { enabled: Boolean(safetyReserve) },
  });

  const position = walletReads.data?.[0]?.result as Position | undefined;
  const maxMintable = walletReads.data?.[1]?.result as bigint | undefined;
  const maxWithdrawable = (walletReads.data?.[2]?.result as bigint | undefined) ?? position?.[4];
  const mintPaused = reads.data?.[0]?.result as boolean | undefined;
  const withdrawPaused = reads.data?.[1]?.result as boolean | undefined;

  const totalSafetyReserve = reserveReads.data?.[0]?.result as bigint | undefined;
  const freeSafetyReserve = reserveReads.data?.[1]?.result as bigint | undefined;
  const entryTvl = reserveReads.data?.[2]?.result as bigint | undefined;
  const sponsorshipActive = reserveReads.data?.[3]?.result as boolean | undefined;
  const allocationsPaused = reserveReads.data?.[4]?.result as boolean | undefined;

  const mintQuoteState = useReadContract({
    address: vault,
    abi: synthVaultAbi,
    functionName: "quoteDepositAndMint",
    args: amount && mode === "mint" && address ? [address, amount] : undefined,
    query: {
      enabled: Boolean(vault && address && amount && mode === "mint" && oracleState.data && vaultStatus.ready),
    },
  });
  const mintQuote = mintQuoteState.data as MintQuote | undefined;
  const quotedMintAmount = mintQuote?.[0];
  const minimumMintAmount = amountAfterHaircut(quotedMintAmount);
  const reserveRequired = mintQuote?.[1];
  const quoteUsesSponsorship = mintQuote?.[2] === true;
  const mintFeeState = useReadContract({
    address: vault,
    abi: synthVaultAbi,
    functionName: "quoteMintFee",
    args: minimumMintAmount && mode === "mint" ? [minimumMintAmount] : undefined,
    query: {
      enabled: Boolean(vault && minimumMintAmount && mode === "mint" && oracleState.data && vaultStatus.ready),
    },
  });
  const quotedMintFee = mintFeeState.data as bigint | undefined;
  const maximumMintFee = amountWithTolerance(quotedMintFee);
  const maximumMintDebit = amount && maximumMintFee !== undefined ? amount + maximumMintFee : undefined;

  const userCollateral = position?.[0];
  const reserveCollateral = position?.[1];
  const synthDebt = position?.[2];
  const positionHealth = position?.[3];
  const sourceBalance = mode === "mint" || mode === "topup"
    ? nusdBalance.data
    : mode === "repay"
      ? synthBalance.data
      : maxWithdrawable;
  const mintMaximum = nusdBalance.data === undefined
    ? undefined
    : nusdBalance.data * BPS_DENOMINATOR / (BPS_DENOMINATOR + MAX_MINT_FEE_RATE_BPS);
  const maximumAmount = mode === "repay" && sourceBalance !== undefined && synthDebt !== undefined
    ? synthDebt < sourceBalance ? synthDebt : sourceBalance
    : mode === "mint" ? mintMaximum : sourceBalance;
  const configured = Boolean(vault && assets.NUSD.address && synthAddress && oracle);
  const activationBlocked = (mode === "mint" || mode === "topup") && !vaultStatus.ready;
  const mintBlocked = mode === "mint" && oracleState.data !== true;
  const withdrawBlocked = mode === "withdraw" && synthDebt !== 0n && oracleState.data !== true;
  const riskBlocked = activationBlocked || mintBlocked || withdrawBlocked;
  const safetyProgress = useMemo(() => {
    if (totalSafetyReserve === undefined || !entryTvl) return undefined;
    const progressBps = totalSafetyReserve >= entryTvl ? 10_000n : totalSafetyReserve * 10_000n / entryTvl;
    return Number(progressBps) / 100;
  }, [entryTvl, totalSafetyReserve]);
  const healthNumber = positionHealth === undefined || positionHealth > 10n ** 30n
    ? undefined
    : Number(positionHealth) / 1e18;
  const healthDisplay = synthDebt === 0n
    ? "No debt"
    : healthNumber === undefined
      ? "--"
      : `${healthNumber.toFixed(2)} ${healthNumber < 1 ? "Liquidatable" : "Safe"}`;
  const healthTone: "default" | "positive" | "danger" = synthDebt === undefined || healthNumber === undefined
    ? "default"
    : synthDebt === 0n || healthNumber >= 1 ? "positive" : "danger";

  const error = useMemo(() => {
    if (!amountText) return undefined;
    if (!amount) return "Enter a valid positive amount.";
    const requiredBalance = mode === "mint" ? maximumMintDebit : amount;
    if (sourceBalance !== undefined && requiredBalance !== undefined && requiredBalance > sourceBalance) {
      return mode === "withdraw"
        ? "Amount exceeds your withdrawable NUSD. Reserve backing cannot be withdrawn."
        : mode === "mint"
          ? "NUSD balance does not cover the maximum mint debit."
          : "Amount exceeds the available balance.";
    }
    if (mode === "repay" && synthDebt !== undefined && amount > synthDebt) {
      return "Repayment exceeds current synth debt.";
    }
    if (mode === "mint" && mintPaused) return "Minting is paused by governance.";
    if (mode === "mint" && mintQuoteState.isError) return "Unable to quote this mint from the DIA price.";
    if (mode === "mint" && mintFeeState.isError) return "Unable to quote the bounded mint fee.";
    if (mode === "mint" && minimumMintAmount === 0n) return "This NUSD amount cannot safely mint more synth.";
    if (mode === "withdraw" && withdrawPaused) return "Collateral withdrawals are paused by governance.";
    if ((mode === "mint" || (mode === "withdraw" && synthDebt !== 0n)) && oracleState.data !== true) {
      return "DIA price is unavailable.";
    }
    return undefined;
  }, [amount, amountText, maximumMintDebit, minimumMintAmount, mintFeeState.isError, mintPaused, mintQuoteState.isError, mode, oracleState.data, sourceBalance, synthDebt, withdrawPaused]);

  function changeMode(nextMode: SynthMode) {
    setMode(nextMode);
    setAmountText("");
    tx.reset();
  }

  async function submit() {
    if (!amount || !address || !synthAddress || activationBlocked) return;
    const call = mode === "topup"
      ? { functionName: "depositCollateral", args: [amount, address] as const }
      : mode === "mint"
        ? minimumMintAmount && maximumMintFee !== undefined
          ? { functionName: "depositAndMint", args: [amount, minimumMintAmount, maximumMintFee, address] as const }
          : undefined
        : mode === "repay"
          ? { functionName: "repay", args: [amount, address] as const }
          : { functionName: "withdrawCollateral", args: [amount, address] as const };
    if (!call) return;
    const approval = mode === "topup" || mode === "mint"
      ? { token: assets.NUSD.address, spender: vault, amount: mode === "mint" ? maximumMintDebit ?? amount : amount }
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
      const detail = mode === "mint" && minimumMintAmount
        ? `${formatTokenAmount(minimumMintAmount)} ${synth} received with a ${formatAmount(maximumMintDebit)} NUSD maximum debit.`
        : "Vault position updated.";
      toast.show(labels[mode], detail, "success");
      setAmountText("");
      void reads.refetch();
      void walletReads.refetch();
      void reserveReads.refetch();
      void safetyReserveState.refetch();
      void nusdBalance.refetch();
      void synthBalance.refetch();
    }
  }

  const modeLabel = sponsorshipActive === undefined
    ? "--"
    : sponsorshipActive
      ? "1:1 reserve-backed"
      : "150% collateral";
  const modeTone = sponsorshipActive ? "positive" : "warning";
  const safetyTvlDetail = totalSafetyReserve === undefined || entryTvl === undefined
    ? "--"
    : `${formatAmount(totalSafetyReserve, 18, 0)} / ${formatAmount(entryTvl, 18, 0)} NUSD`;

  return (
    <>
      <MetricStrip metrics={[
        { label: "Vault mode", value: modeLabel, tone: modeTone },
        { label: "Reserve funded", value: safetyProgress === undefined ? "--" : `${safetyProgress.toFixed(safetyProgress < 1 ? 2 : 0)}%` },
        { label: "Your mint capacity", value: `${formatTokenAmount(maxMintable)} ${synth}` },
        { label: "Health factor", value: healthDisplay, tone: healthTone },
      ]} />
      <div className="fi-workspace-grid fi-workspace-balance">
        <section className="fi-panel">
          <PanelHeading title={`${synth} position`} />
          <div className="fi-preview-value">
            <span>Synth debt</span>
            <strong>{formatTokenAmount(synthDebt)} {synth}</strong>
          </div>
          <dl className="fi-position-list">
            <div className="fi-position-row"><span>Locked collateral</span><strong>{formatAmount(userCollateral)} NUSD</strong></div>
            <div className="fi-position-row"><span>Withdrawable</span><strong>{formatAmount(maxWithdrawable)} NUSD</strong></div>
          </dl>
          <details className="fi-pool-details">
            <summary>Reserve details</summary>
            <dl>
              <div><dt>Safety reserve</dt><dd>{safetyTvlDetail}</dd></div>
              <div><dt>Position backing</dt><dd>{formatAmount(reserveCollateral)} NUSD</dd></div>
              <div><dt>Free reserve</dt><dd>{formatAmount(freeSafetyReserve)} NUSD</dd></div>
              <div><dt>Allocations</dt><dd>{allocationsPaused === undefined ? "--" : allocationsPaused ? "Paused" : "Open"}</dd></div>
            </dl>
          </details>
        </section>
        <section className="fi-panel fi-sticky-panel">
          <PanelHeading title={`${synth} vault`} />
          {!configured ? <NotDeployed feature={`${synth} vault`} /> : null}
          {configured && !vaultStatus.ready ? (
            <div className="fi-inline-state fi-inline-warning">
              <div><strong>{vaultStatus.title}</strong><span>{vaultStatus.message}</span></div>
            </div>
          ) : null}
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
          <div className="fi-segmented" role="group" aria-label="Synthetic debt action">
            <button type="button" className={mode === "mint" ? "active" : ""} aria-pressed={mode === "mint"} onClick={() => changeMode("mint")}>Mint</button>
            <button type="button" className={mode === "repay" ? "active" : ""} aria-pressed={mode === "repay"} onClick={() => changeMode("repay")}>Repay</button>
          </div>
          <details className="fi-settings-details">
            <summary>
              <span>Manage collateral</span>
              <strong>{mode === "topup" ? "Top up" : mode === "withdraw" ? "Withdraw" : `${formatAmount(userCollateral)} NUSD`}</strong>
            </summary>
            <div className="fi-section-stack fi-slippage-control fi-disclosure-body">
              <div className="fi-segmented" role="group" aria-label="Synthetic collateral action">
                <button type="button" className={mode === "topup" ? "active" : ""} aria-pressed={mode === "topup"} onClick={() => changeMode("topup")}>Top up</button>
                <button type="button" className={mode === "withdraw" ? "active" : ""} aria-pressed={mode === "withdraw"} onClick={() => changeMode("withdraw")}>Withdraw</button>
              </div>
            </div>
          </details>
          <form className="fi-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <AmountField
              id="synth-input"
              label={mode === "mint" ? "You deposit" : mode === "topup" ? "Top up" : mode === "repay" ? "Repay" : "Withdraw"}
              asset={mode === "repay" ? synth : "NUSD"}
              value={amountText}
              balance={mode === "withdraw" ? formatAmount(maxWithdrawable) : mode === "repay" ? formatTokenAmount(sourceBalance) : formatAmount(sourceBalance)}
              helper={mode === "mint" ? `NUSD is locked as collateral while ${synth} is minted.` : undefined}
              onChange={setAmountText}
              onMax={maximumAmount && maximumAmount > 0n ? () => setAmountText(formatUnits(maximumAmount, 18)) : undefined}
              error={error}
            />
            {mode === "mint" ? (
              <>
                <dl className="fi-form-details" aria-label="Mint preview">
                  <div><dt>You receive at least</dt><dd>{formatTokenAmount(minimumMintAmount)} {synth}</dd></div>
                  <div><dt>You spend at most</dt><dd>{formatAmount(maximumMintDebit)} NUSD</dd></div>
                </dl>
                {amount ? (
                  <details className="fi-pool-details">
                    <summary>Mint details</summary>
                    <dl>
                      <div><dt>Collateral locked</dt><dd>{formatAmount(amount)} NUSD</dd></div>
                      <div><dt>Maximum fee</dt><dd>{formatAmount(maximumMintFee)} NUSD</dd></div>
                      <div><dt>Reserve added</dt><dd>{formatAmount(reserveRequired)} NUSD</dd></div>
                      <div><dt>Backing</dt><dd>{mintQuote ? quoteUsesSponsorship ? "1:1 + reserve" : "150% safety" : "--"}</dd></div>
                    </dl>
                  </details>
                ) : null}
              </>
            ) : mode === "withdraw" ? (
              <dl className="fi-form-details">
                <div><dt>Your locked NUSD</dt><dd>{formatAmount(userCollateral)} NUSD</dd></div>
                <div><dt>Available to withdraw</dt><dd>{formatAmount(maxWithdrawable)} NUSD</dd></div>
              </dl>
            ) : null}
            {(mintBlocked || withdrawBlocked) && !activationBlocked ? <div className="fi-inline-state fi-inline-warning"><div><strong>DIA price unavailable</strong></div></div> : null}
            {!isConnected ? <ConnectWalletButton /> : (
              <button
                type="submit"
                className={`fi-button fi-button-block ${mode === "withdraw" ? "fi-button-muted" : "fi-button-primary"}`}
                disabled={!configured || riskBlocked || !amount || (mode === "mint" && (!minimumMintAmount || maximumMintFee === undefined)) || Boolean(error) || tx.pending}
              >
                {!configured ? "Not deployed" : activationBlocked ? vaultStatus.actionLabel : tx.pending ? "Processing" : mode === "mint" ? `Mint ${synth}` : mode === "topup" ? "Top up" : `${mode[0].toUpperCase()}${mode.slice(1)}`}
              </button>
            )}
            <TransactionStatus phase={tx.phase} message={tx.message} hash={tx.hash} />
          </form>
        </section>
      </div>
    </>
  );
}
