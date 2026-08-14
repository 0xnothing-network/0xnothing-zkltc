"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { formatUnits, zeroAddress } from "viem";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { AmountField } from "@fi/components/AmountField";
import { ConnectWalletButton } from "@fi/components/ConnectWalletButton";
import { NotDeployed, TransactionStatus } from "@fi/components/UiStates";
import { useToast } from "@fi/components/Toast";
import { canonicalPairs, assetForPool, pairSlug, type AssetSymbol } from "@fi/config/assets";
import { deployment } from "@fi/config/deployment";
import { fiPath } from "@fi/config/paths";
import { dexFactoryAbi, dexPoolAbi } from "@fi/lib/abis/dex";
import { farmFactoryAbi, farmGaugeAbi } from "@fi/lib/abis/farm";
import { formatAmount, parseAmount } from "@fi/lib/format";
import { useProtocolTransaction } from "@fi/lib/hooks/useProtocolTransaction";

type RewardProgramState = "loading" | "ready" | "active" | "unfunded" | "ended" | "setup" | "unavailable";

function FarmRow({
  pair,
  nowSeconds,
  expandRequested = false,
}: {
  pair: readonly [AssetSymbol, AssetSymbol];
  nowSeconds?: number;
  expandRequested?: boolean;
}) {
  const [tokenA, tokenB] = pair;
  const slug = pairSlug(tokenA, tokenB);
  const addressA = assetForPool(tokenA);
  const addressB = assetForPool(tokenB);
  const { address, isConnected } = useAccount();
  const toast = useToast();
  const [mode, setMode] = useState<"stake" | "withdraw">("stake");
  const [amountText, setAmountText] = useState("");
  const [expanded, setExpanded] = useState(expandRequested);
  const amount = parseAmount(amountText);
  const tx = useProtocolTransaction();
  const poolRead = useReadContract({
    address: deployment.contracts.dexFactory,
    abi: dexFactoryAbi,
    functionName: "getPair",
    args: addressA && addressB ? [addressA, addressB] : undefined,
    query: { enabled: Boolean(deployment.contracts.dexFactory && addressA && addressB) },
  });
  const pool = poolRead.data && poolRead.data !== zeroAddress ? poolRead.data : undefined;
  const configuredGauge = tokenA === "zkLTC"
    ? deployment.contracts.wzkLtcNusdGauge
    : tokenA === "nBTC"
      ? deployment.contracts.nbtcNusdGauge
      : tokenA === "nETH"
        ? deployment.contracts.nethNusdGauge
        : undefined;
  const gaugeRead = useReadContract({
    address: deployment.contracts.farmFactory,
    abi: farmFactoryAbi,
    functionName: "gaugeForPair",
    args: pool ? [pool] : undefined,
    query: { enabled: Boolean(!configuredGauge && deployment.contracts.farmFactory && pool) },
  });
  const gauge = configuredGauge
    || (gaugeRead.data && gaugeRead.data !== zeroAddress ? gaugeRead.data : undefined);
  const stats = useReadContracts({
    contracts: gauge && pool ? [
      { address: gauge, abi: farmGaugeAbi, functionName: "rewardRate" },
      { address: gauge, abi: farmGaugeAbi, functionName: "periodFinish" },
      { address: gauge, abi: farmGaugeAbi, functionName: "totalSupply" },
      { address: gauge, abi: farmGaugeAbi, functionName: "depositsPaused" },
      { address: gauge, abi: farmGaugeAbi, functionName: "totalFunded" },
      { address: gauge, abi: farmGaugeAbi, functionName: "pausedRewardDuration" },
    ] as const : [],
    query: { enabled: Boolean(gauge && pool) },
  });
  const walletStats = useReadContracts({
    contracts: address && gauge && pool ? [
      { address: gauge, abi: farmGaugeAbi, functionName: "balanceOf", args: [address] },
      { address: gauge, abi: farmGaugeAbi, functionName: "earned", args: [address] },
      { address: pool, abi: dexPoolAbi, functionName: "balanceOf", args: [address] },
    ] as const : [],
    query: { enabled: Boolean(address && gauge && pool) },
  });
  const rewardRate = stats.data?.[0]?.result as bigint | undefined;
  const periodFinish = stats.data?.[1]?.result as bigint | undefined;
  const totalStaked = stats.data?.[2]?.result as bigint | undefined;
  const depositsPaused = stats.data?.[3]?.result as boolean | undefined;
  const totalFunded = stats.data?.[4]?.result as bigint | undefined;
  const pausedRewardDuration = stats.data?.[5]?.result as bigint | undefined;
  const staked = walletStats.data?.[0]?.result as bigint | undefined;
  const earned = walletStats.data?.[1]?.result as bigint | undefined;
  const walletLp = walletStats.data?.[2]?.result as bigint | undefined;
  const walletResults = walletStats.data?.slice(0, 3);
  const walletReadFailed = Boolean(
    address
      && (
        walletStats.isError
        || walletResults?.some((result) => result.status === "failure")
      ),
  );
  const walletReadsReady = Boolean(
    address
      && staked !== undefined
      && earned !== undefined
      && walletLp !== undefined
      && !walletReadFailed,
  );
  const walletReadsLoading = Boolean(
    address
      && !walletReadFailed
      && !walletReadsReady,
  );
  const available = mode === "stake" ? walletLp : staked;
  const configured = Boolean(pool && gauge);
  const discoveryLoading = poolRead.isPending
    || Boolean(pool && !configuredGauge && gaugeRead.isPending);
  const requiredProgramResults = stats.data?.slice(0, 5);
  const programReadFailed = Boolean(
    poolRead.isError
      || gaugeRead.isError
      || stats.isError
      || requiredProgramResults?.some((result) => result.status === "failure"),
  );
  const programReadsReady = rewardRate !== undefined
    && periodFinish !== undefined
    && totalStaked !== undefined
    && depositsPaused !== undefined
    && totalFunded !== undefined;
  const rewardsActive = Boolean(
    configured
      && nowSeconds !== undefined
      && rewardRate
      && rewardRate > 0n
      && periodFinish
      && periodFinish > BigInt(nowSeconds),
  );
  const rewardsReady = Boolean(
    configured
      && nowSeconds !== undefined
      && rewardRate
      && rewardRate > 0n
      && periodFinish !== undefined
      && periodFinish <= BigInt(nowSeconds)
      && totalStaked === 0n
      && pausedRewardDuration !== undefined
      && pausedRewardDuration > 0n,
  );
  const rewardsUnfunded = Boolean(
    configured
      && totalFunded === 0n
      && rewardRate === 0n
      && periodFinish === 0n,
  );
  const programState: RewardProgramState = discoveryLoading
    || (configured && (stats.isPending || nowSeconds === undefined))
    ? "loading"
    : programReadFailed
      ? "unavailable"
      : !configured
        ? "setup"
        : !programReadsReady
          ? "unavailable"
          : rewardsUnfunded
            ? "unfunded"
            : rewardsActive
              ? "active"
              : rewardsReady ? "ready" : "ended";
  const programStatus = {
    loading: { label: "Checking", tone: "warning" },
    ready: { label: "Ready", tone: "live" },
    active: { label: "Active", tone: "live" },
    unfunded: { label: "Unfunded", tone: "warning" },
    ended: { label: "Ended", tone: "warning" },
    setup: { label: "Setup needed", tone: "offline" },
    unavailable: { label: "Unavailable", tone: "offline" },
  }[programState];
  const rewardsPerDay = (programState === "active" || programState === "ready") && rewardRate !== undefined
    ? rewardRate * 86_400n
    : programState === "ended" ? 0n : undefined;
  const rewardsPerDayLabel = programState === "unfunded"
    ? "Not started"
    : rewardsPerDay === undefined ? "--" : `${formatAmount(rewardsPerDay)} NUSD`;
  const stakeAvailable = programState === "active" || programState === "ready";
  const stakeButtonLabel = depositsPaused
    ? "Deposits paused"
    : programState === "unfunded"
      ? "Rewards not started"
      : programState === "ended"
        ? "Rewards ended"
        : programState === "loading"
          ? "Checking rewards"
          : programState === "unavailable"
            ? "Farm unavailable"
            : programState === "setup"
              ? "Farm not configured"
              : "Stake LP";
  const invalid = useMemo(() => {
    if (!amountText) return undefined;
    if (!amount) return "Enter a valid LP amount.";
    if (available !== undefined && amount > available) return "Amount exceeds available LP balance.";
    if (mode === "stake" && !stakeAvailable) return "Rewards are not active.";
    if (mode === "stake" && depositsPaused) return "New deposits are paused.";
    return undefined;
  }, [amount, amountText, available, depositsPaused, mode, stakeAvailable]);

  useEffect(() => {
    if ((programState === "unfunded" || programState === "ended") && staked && staked > 0n) {
      setMode((current) => current === "stake" ? "withdraw" : current);
    }
  }, [programState, staked]);

  async function positionAction() {
    if (!amount || !gauge || !pool) return;
    if (!walletReadsReady) return;
    if (mode === "stake" && (!stakeAvailable || depositsPaused)) return;
    const hash = await tx.execute({
      approval: mode === "stake" ? { token: pool, spender: gauge, amount } : undefined,
      call: { address: gauge, abi: farmGaugeAbi, functionName: mode, args: [amount] },
    });
    if (hash) {
      toast.show(mode === "stake" ? "LP staked" : "LP withdrawn", `${tokenA}/${tokenB} position updated.`, "success");
      setAmountText(""); void stats.refetch(); void walletStats.refetch();
    }
  }

  async function claim() {
    if (!gauge || !earned || !walletReadsReady) return;
    const hash = await tx.execute({ call: { address: gauge, abi: farmGaugeAbi, functionName: "getReward" } });
    if (hash) { toast.show("Rewards claimed", "Farm rewards were settled to your wallet.", "success"); void stats.refetch(); void walletStats.refetch(); }
  }

  function retryReads() {
    void poolRead.refetch();
    if (!configuredGauge) void gaugeRead.refetch();
    void stats.refetch();
    if (address) void walletStats.refetch();
  }

  return (
    <article id={`farm-card-${slug}`} className="fi-panel fi-farm-row" data-program-state={programState} aria-labelledby={`farm-title-${slug}`}>
      <div className="fi-farm-summary">
        <div className="fi-farm-identity">
          <span className="fi-label">LP farm</span>
          <h2 id={`farm-title-${slug}`}>{tokenA}/{tokenB}</h2>
        </div>
        <span className="fi-status" data-state={programStatus.tone} aria-live="polite">{programStatus.label}</span>
        <div className="fi-farm-summary-actions">
          <Link className="fi-button fi-button-muted" href={fiPath(`/pools/${slug}?action=add&from=earn`)}>Add LP</Link>
          <button
            type="button"
            className="fi-button fi-button-muted"
            aria-expanded={expanded}
            aria-controls={`farm-manage-${slug}`}
            disabled={tx.pending}
            onClick={() => {
              if (expanded) tx.reset();
              setExpanded((current) => !current);
            }}
          >
            {expanded ? "Close" : staked && staked > 0n ? "Position" : "Stake"}
          </button>
        </div>
      </div>
      <dl className="fi-trade-quote" aria-label={`${tokenA}/${tokenB} farm summary`}>
        <div><dt>Rewards / day</dt><dd>{rewardsPerDayLabel}</dd></div>
        <div><dt>Your stake</dt><dd>{formatAmount(staked)} LP</dd></div>
        <div><dt>Earned</dt><dd>{formatAmount(earned)} NUSD</dd></div>
      </dl>
      <div id={`farm-manage-${slug}`} className="fi-section-stack" hidden={!expanded}>
        {programState === "setup" ? <NotDeployed feature={`${tokenA}/${tokenB} farm`} /> : null}
        {programState === "unfunded" ? (
          <div className="fi-inline-state fi-inline-warning fi-farm-program-note" role="status">
            <div>
              <strong>Rewards not started</strong>
              <span>No NUSD reward schedule is funded. Existing LP remains withdrawable.</span>
            </div>
          </div>
        ) : null}
        {programState === "ended" ? (
          <div className="fi-inline-state fi-inline-warning fi-farm-program-note" role="status">
            <div>
              <strong>Reward period ended</strong>
              <span>Withdraw LP or claim any NUSD already earned.</span>
            </div>
          </div>
        ) : null}
        {programState === "ready" ? (
          <div className="fi-inline-state fi-farm-program-note" role="status">
            <div>
              <strong>Rewards ready</strong>
              <span>The reward clock starts when LP is staked.</span>
            </div>
          </div>
        ) : null}
        {programState === "unavailable" || walletReadFailed ? (
          <div className="fi-inline-state fi-inline-danger fi-farm-program-note" role="alert">
            <div>
              <strong>{programState === "unavailable" ? "Farm data unavailable" : "Wallet position unavailable"}</strong>
              <span>Your funds are unchanged. Retry the on-chain reads.</span>
            </div>
            <button type="button" className="fi-button fi-button-muted" onClick={retryReads}>Retry</button>
          </div>
        ) : null}
        <dl className="fi-form-details">
          <div><dt>Total staked</dt><dd>{formatAmount(totalStaked)} LP</dd></div>
          <div><dt>LP in wallet</dt><dd>{formatAmount(walletLp)} LP</dd></div>
        </dl>
        <div className="fi-farm-actions">
          <div className="fi-segmented" role="group" aria-label={`${tokenA}/${tokenB} farm action`}>
            <button type="button" className={mode === "stake" ? "active positive" : ""} aria-pressed={mode === "stake"} onClick={() => { setMode("stake"); setAmountText(""); tx.reset(); }}>Stake</button>
            <button type="button" className={mode === "withdraw" ? "active" : ""} aria-pressed={mode === "withdraw"} onClick={() => { setMode("withdraw"); setAmountText(""); tx.reset(); }}>Withdraw</button>
          </div>
          {mode === "stake" && walletLp === 0n ? (
            <div className="fi-farm-no-lp">
              <div>
                <strong>No LP in wallet</strong>
                <span>Add both pool assets first, then return here to stake.</span>
              </div>
              <Link className="fi-button fi-button-muted" href={fiPath(`/pools/${slug}?action=add&from=earn`)}>Add liquidity</Link>
            </div>
          ) : null}
          <AmountField id={`farm-${slug}`} label={mode === "stake" ? "Stake" : "Withdraw"} asset="LP" value={amountText} balance={formatAmount(available)} onChange={setAmountText} onMax={available && available > 0n ? () => setAmountText(formatUnits(available, 18)) : undefined} error={invalid} />
          {!isConnected ? <ConnectWalletButton /> : (
            <div className="fi-action-grid">
              <button
                type="button"
                className={`fi-button ${mode === "stake" ? "fi-button-primary" : "fi-button-muted"}`}
                disabled={!configured || !walletReadsReady || (mode === "stake" && (!stakeAvailable || depositsPaused)) || !amount || Boolean(invalid) || tx.pending}
                onClick={() => void positionAction()}
              >
                {tx.pending
                  ? "Processing"
                  : walletReadsLoading
                    ? "Loading position"
                    : mode === "stake"
                      ? stakeButtonLabel
                      : "Withdraw LP"}
              </button>
              <button type="button" className="fi-button fi-button-muted" disabled={!configured || !walletReadsReady || !earned || tx.pending} onClick={() => void claim()}>
                {earned && earned > 0n ? `Claim ${formatAmount(earned)} NUSD` : "Claim rewards"}
              </button>
            </div>
          )}
          <TransactionStatus phase={tx.phase} message={tx.message} hash={tx.hash} />
        </div>
      </div>
    </article>
  );
}

export function FarmDashboard({ initialPair }: { initialPair?: string } = {}) {
  const [nowSeconds, setNowSeconds] = useState<number>();

  useEffect(() => {
    const updateClock = () => setNowSeconds(Math.floor(Date.now() / 1000));
    updateClock();
    const timer = window.setInterval(updateClock, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!deployment.contracts.dexFactory || !deployment.contracts.farmFactory) return <NotDeployed feature="LP farming" />;
  return (
    <section className="fi-section-stack" aria-label="Liquidity farms">
      <div className="fi-panel fi-earn-guide" aria-label="How liquidity farming works">
        <div className="fi-earn-guide-heading">
          <span className="fi-label">How to earn</span>
          <strong>LP to NUSD in 3 steps</strong>
        </div>
        <ol className="fi-earn-steps">
          <li><span>01</span><strong>Add liquidity</strong><small>Receive LP</small></li>
          <li><span>02</span><strong>Stake LP</strong><small>Active farms only</small></li>
          <li><span>03</span><strong>Claim NUSD</strong><small>Withdraw anytime</small></li>
        </ol>
      </div>
      {canonicalPairs.map((pair) => {
        const slug = pairSlug(pair[0], pair[1]);
        return <FarmRow pair={pair} nowSeconds={nowSeconds} expandRequested={initialPair?.toLowerCase() === slug} key={slug} />;
      })}
    </section>
  );
}
