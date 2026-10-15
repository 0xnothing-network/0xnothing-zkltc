"use client";

import { useEffect, useMemo, useState } from "react";
import { formatUnits, type Address } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { AmountField } from "@fi/components/AmountField";
import { ConnectWalletButton } from "@fi/components/ConnectWalletButton";
import { NotDeployed, TransactionStatus } from "@fi/components/UiStates";
import { useToast } from "@fi/components/Toast";
import { deployment } from "@fi/config/deployment";
import { erc20Abi } from "@fi/lib/abis/erc20";
import { rewardLockOptions, rewardStakingAbi } from "@fi/lib/abis/tokenomics";
import { formatAmount, parseAmount } from "@fi/lib/format";
import { useProtocolTransaction } from "@fi/lib/hooks/useProtocolTransaction";

const REWARDS_POLL_MS = 10_000;
const POSITION_LIMIT = 50;
const SECONDS_PER_DAY = 86_400n;
const SECONDS_PER_YEAR = 31_536_000n;
const STREAM_SECONDS = 7n * SECONDS_PER_DAY;

type RewardPosition = {
  account: Address;
  unlockTime: bigint;
  lockDuration: number;
  withdrawn: boolean;
  amount: bigint;
  weight: bigint;
};

function formatDate(seconds: bigint | number | undefined): string {
  if (seconds === undefined) return "--";
  return `${new Date(Number(seconds) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** 1 0xPoint = 1 NUSD of lock-weighted stake held for one day. */
function formatPoints(points: bigint | undefined): string {
  if (points === undefined) return "--";
  return formatAmount(points / SECONDS_PER_DAY, 18, 2);
}

/** Yearly rate of `perSecond` NUSD against `base`, as a percentage with two decimals. */
function formatApr(perSecond: bigint | undefined, base: bigint | undefined): string {
  if (perSecond === undefined || !base) return "--";
  return `${(Number((perSecond * SECONDS_PER_YEAR * 10_000n) / base) / 100).toFixed(2)}%`;
}

/**
 * The claimable figure accrues every second between reads. It owns that one-second clock so the
 * rest of the dashboard repaints only when its data or the slower page clock changes.
 */
function LiveClaimable({
  atRead,
  readAtMs,
  perSecond,
  periodFinish,
}: {
  atRead: bigint | undefined;
  readAtMs: number;
  perSecond: bigint | undefined;
  periodFinish: bigint | undefined;
}) {
  const accruing = Boolean(atRead !== undefined && perSecond && periodFinish && readAtMs);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!accruing) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [accruing]);
  let value = atRead;
  if (accruing && atRead !== undefined && perSecond && periodFinish) {
    const readAt = BigInt(Math.floor(readAtMs / 1000));
    const now = BigInt(Math.floor(nowMs / 1000));
    const end = now < periodFinish ? now : periodFinish;
    if (end > readAt) value = atRead + perSecond * (end - readAt);
  }
  return formatAmount(value, 18, 6);
}

export function RewardsDashboard() {
  const { address, isConnected } = useAccount();
  const toast = useToast();
  const tx = useProtocolTransaction();
  const [amountText, setAmountText] = useState("");
  const [duration, setDuration] = useState<number>(rewardLockOptions[0].duration);
  const [nowMs, setNowMs] = useState<number>();
  const staking = deployment.contracts.rewardStaking;
  const nusd = deployment.contracts.nusd;
  const amount = parseAmount(amountText);
  const selectedLock = rewardLockOptions.find((option) => option.duration === duration) ?? rewardLockOptions[0];

  // Page clock for the stream state, maturities and the unlock preview; the claimable figure
  // keeps its own one-second clock (LiveClaimable).
  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    tick();
    const timer = window.setInterval(tick, 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const nowSeconds = nowMs === undefined ? undefined : Math.floor(nowMs / 1000);

  const pool = useReadContracts({
    contracts: staking ? [
      { address: staking, abi: rewardStakingAbi, functionName: "rewardRate" },
      { address: staking, abi: rewardStakingAbi, functionName: "periodFinish" },
      { address: staking, abi: rewardStakingAbi, functionName: "totalWeight" },
      { address: staking, abi: rewardStakingAbi, functionName: "totalPrincipal" },
      { address: staking, abi: rewardStakingAbi, functionName: "queuedRewards" },
    ] as const : [],
    query: { enabled: Boolean(staking), refetchInterval: REWARDS_POLL_MS, refetchIntervalInBackground: false },
  });
  const rewardRate = pool.data?.[0]?.result as bigint | undefined;
  const periodFinish = pool.data?.[1]?.result as bigint | undefined;
  const totalWeight = pool.data?.[2]?.result as bigint | undefined;
  const totalPrincipal = pool.data?.[3]?.result as bigint | undefined;
  const queued = pool.data?.[4]?.result as bigint | undefined;

  const wallet = useReadContracts({
    contracts: address && staking && nusd ? [
      { address: nusd, abi: erc20Abi, functionName: "balanceOf", args: [address] },
      { address: staking, abi: rewardStakingAbi, functionName: "accountState", args: [address] },
      { address: staking, abi: rewardStakingAbi, functionName: "positionIdsOf", args: [address] },
    ] as const : [],
    query: { enabled: Boolean(address && staking && nusd), refetchInterval: REWARDS_POLL_MS, refetchIntervalInBackground: false },
  });
  const walletNusd = wallet.data?.[0]?.result as bigint | undefined;
  const account = wallet.data?.[1]?.result as readonly [bigint, bigint, bigint] | undefined;
  const allPositionIds = wallet.data?.[2]?.result as readonly bigint[] | undefined;
  const [weight, points, claimableAtRead] = account ?? [undefined, undefined, undefined];
  const positionIds = useMemo(() => (allPositionIds ?? []).slice(-POSITION_LIMIT), [allPositionIds]);

  const positionReads = useReadContracts({
    contracts: positionIds.map((positionId) => ({
      address: staking!,
      abi: rewardStakingAbi,
      functionName: "getPosition" as const,
      args: [positionId] as const,
    })),
    query: { enabled: Boolean(staking && positionIds.length), refetchInterval: REWARDS_POLL_MS, refetchIntervalInBackground: false },
  });
  const positions = useMemo(() => positionReads.data?.flatMap((read, index) => (
    read.status === "success" ? [{ id: positionIds[index], position: read.result as RewardPosition }] : []
  )).reverse() ?? [], [positionIds, positionReads.data]);

  const activePrincipal = positions.reduce((sum, { position }) => (position.withdrawn ? sum : sum + position.amount), 0n);
  const streaming = Boolean(rewardRate && totalWeight && periodFinish && nowSeconds !== undefined && BigInt(nowSeconds) < periodFinish);
  const yourRate = rewardRate !== undefined && weight !== undefined && totalWeight
    ? (rewardRate * weight) / totalWeight
    : undefined;
  // Something to claim now, or accruing until the next read shows it.
  const claimable = Boolean(claimableAtRead || (yourRate && streaming));
  const streamProgress = streaming && periodFinish && nowSeconds !== undefined
    ? Math.max(0, Math.min(1, 1 - Number(periodFinish - BigInt(nowSeconds)) / Number(STREAM_SECONDS)))
    : 0;
  const previewWeight = amount ? (amount * BigInt(selectedLock.multiplierBps)) / 10_000n : undefined;
  const previewRate = previewWeight !== undefined && rewardRate !== undefined && totalWeight !== undefined && streaming
    ? (rewardRate * previewWeight) / (totalWeight + previewWeight)
    : undefined;
  const walletReady = !address || (walletNusd !== undefined && account !== undefined);
  const invalid = useMemo(() => {
    if (!amountText) return undefined;
    if (!amount) return "Enter a valid NUSD amount.";
    if (walletNusd !== undefined && amount > walletNusd) return "Amount exceeds your NUSD balance.";
    return undefined;
  }, [amount, amountText, walletNusd]);

  const caption = streaming
    ? <><strong>{formatAmount(rewardRate === undefined ? undefined : rewardRate * SECONDS_PER_DAY, 18, 2)}</strong> NUSD/day to stakers · this stream ends {formatDate(periodFinish)}</>
    : queued
      ? <><strong>{formatAmount(queued, 18, 4)}</strong> NUSD queued · it starts streaming with the next stake</>
      : <>No rewards streaming yet · fees start a new 7-day stream as they arrive</>;

  function refresh() {
    void pool.refetch();
    void wallet.refetch();
    void positionReads.refetch();
  }

  async function stake() {
    if (!amount || !staking || !nusd || invalid) return;
    const hash = await tx.execute({
      approval: { token: nusd, spender: staking, amount },
      call: { address: staking, abi: rewardStakingAbi, functionName: "stake", args: [amount, duration] },
    });
    if (hash) {
      toast.show("NUSD staked", `${selectedLock.days}-day lock at ${selectedLock.multiplier}. Rewards and 0xPoints start accruing now.`, "success");
      setAmountText("");
      refresh();
    }
  }

  async function withdraw(positionId: bigint) {
    if (!staking) return;
    const hash = await tx.execute({ call: { address: staking, abi: rewardStakingAbi, functionName: "withdraw", args: [positionId] } });
    if (hash) {
      toast.show("NUSD withdrawn", "The matured principal returned to your wallet.", "success");
      refresh();
    }
  }

  async function claim() {
    if (!staking || !address || !claimable) return;
    const hash = await tx.execute({ call: { address: staking, abi: rewardStakingAbi, functionName: "claim", args: [address] } });
    if (hash) {
      toast.show("Rewards claimed", "Your streamed NUSD was sent to your wallet.", "success");
      refresh();
    }
  }

  async function restake() {
    if (!staking || !claimable) return;
    const hash = await tx.execute({ call: { address: staking, abi: rewardStakingAbi, functionName: "claimAndStake", args: [duration] } });
    if (hash) {
      toast.show("Rewards restaked", `Your rewards are now a ${selectedLock.days}-day lock at ${selectedLock.multiplier}.`, "success");
      refresh();
    }
  }

  if (!staking || !nusd) return <NotDeployed feature="0xPoints staking is not deployed on this network yet." />;

  return (
    <section className="fi-earn" aria-label="NUSD staking and 0xPoints rewards">
      <article className="fi-panel fi-round" aria-labelledby="rewards-stream-title">
        <header className="fi-round-head">
          <div>
            <span className="fi-label">0xPoints rewards</span>
            <h2 id="rewards-stream-title">Reward stream</h2>
          </div>
          <span className="fi-status" data-state={streaming ? "live" : "warning"}>{streaming ? "Streaming" : "Waiting for fees"}</span>
        </header>
        <div className="fi-pixel-progress" role="progressbar" aria-label="Progress of the current 7-day stream" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(streamProgress * 100)}>
          <span style={{ width: `${streamProgress * 100}%` }} />
        </div>
        <p className="fi-round-caption">{caption}</p>
        <dl className="fi-round-stats" aria-label="Your rewards overview">
          <div>
            <dt>Your 0xPoints</dt>
            <dd>{formatPoints(points)}<small>{weight ? `+${formatAmount(weight, 18, 2)}/day` : "lifetime"}</small></dd>
          </div>
          <div>
            <dt>Your rewards</dt>
            <dd>{formatAmount(yourRate === undefined ? undefined : yourRate * SECONDS_PER_DAY, 18, 4)}<small>NUSD/day · APR {formatApr(yourRate, activePrincipal)}</small></dd>
          </div>
          <div>
            <dt>Claimable</dt>
            <dd data-tone="positive"><LiveClaimable atRead={claimableAtRead} readAtMs={wallet.dataUpdatedAt} perSecond={yourRate} periodFinish={periodFinish} /><small>NUSD</small></dd>
            {claimable ? (
              <span className="fi-round-actions">
                <button type="button" className="fi-round-claim" disabled={tx.pending} onClick={() => void claim()}>Claim</button>
                <button type="button" className="fi-round-claim" disabled={tx.pending} onClick={() => void restake()}>Restake {selectedLock.days}d</button>
              </span>
            ) : null}
          </div>
          <div>
            <dt>Total staked</dt>
            <dd>{formatAmount(totalPrincipal, 18, 2)}<small>NUSD · APR {formatApr(rewardRate, totalWeight)} at 1x</small></dd>
          </div>
        </dl>
        <details className="fi-round-help">
          <summary>How rewards work</summary>
          <ol>
            <li>70% of every NUSD fee (0xPump, 0xFi swaps, lending, synth mints) and 80% of each NUSD surplus release go to stakers.</li>
            <li>New income streams out evenly over the next 7 days, split by lock weight: NUSD × 1, 1.2, 1.5 or 3.</li>
            <li>Every stake and claim collects waiting fees first, so the stream runs without anyone in charge.</li>
            <li>Rewards never expire and principal unlocks at maturity. 0xPoints count lock-weighted NUSD-days for life.</li>
          </ol>
        </details>
      </article>

      <div className="fi-earn-workspace">
        <article className="fi-panel fi-earn-stake" aria-labelledby="rewards-stake-title">
          <h2 id="rewards-stake-title" className="fi-earn-title">Stake NUSD</h2>
          <div className="fi-segmented fi-points-locks" role="group" aria-label="Lock duration">
            {rewardLockOptions.map((option) => (
              <button type="button" className={duration === option.duration ? "active positive" : ""} aria-pressed={duration === option.duration} disabled={tx.pending} onClick={() => { setDuration(option.duration); tx.reset(); }} key={option.duration}>
                <span>{option.days}d</span><strong>{option.multiplier}</strong>
              </button>
            ))}
          </div>
          <AmountField id="rewards-stake-nusd" label="Amount" asset="NUSD" value={amountText} balance={formatAmount(walletNusd)} error={invalid} onChange={setAmountText} onMax={walletNusd && walletNusd > 0n ? () => setAmountText(formatUnits(walletNusd, 18)) : undefined} />
          <p className="fi-earn-estimate">
            <span>{previewRate === undefined ? "--" : formatAmount(previewRate * SECONDS_PER_DAY, 18, 4)} NUSD/day now</span>
            <span>Unlocks {amount && nowSeconds ? formatDate(nowSeconds + duration).slice(0, 10) : "--"}</span>
          </p>
          {!isConnected ? <ConnectWalletButton /> : (
            <button type="button" className="fi-button fi-button-block fi-button-primary" disabled={!walletReady || !amount || Boolean(invalid) || tx.pending} onClick={() => void stake()}>
              {tx.pending ? "Processing" : `Stake for ${selectedLock.days} days`}
            </button>
          )}
          <TransactionStatus phase={tx.phase} message={tx.message} hash={tx.hash} step={tx.step} totalSteps={tx.totalSteps} />
        </article>

        <article className="fi-panel fi-earn-locks" aria-labelledby="rewards-positions-title">
          <header className="fi-earn-locks-head">
            <h2 id="rewards-positions-title" className="fi-earn-title">Your locks</h2>
            <span>{allPositionIds === undefined ? "--" : allPositionIds.length}{weight ? ` · ${formatAmount(weight, 18, 2)} 0xPoints/day` : ""}</span>
          </header>
          {!isConnected ? <p className="fi-earn-empty">Connect a wallet to see your locks and rewards.</p> : positions.length === 0 ? (
            <p className="fi-earn-empty">No NUSD locks yet. New stakes appear here without a refresh.</p>
          ) : (
            <ul className="fi-lock-list">
              {positions.map(({ id, position }) => {
                const matured = nowSeconds !== undefined && BigInt(nowSeconds) >= position.unlockTime;
                const option = rewardLockOptions.find((item) => item.duration === position.lockDuration);
                return (
                  <li key={id.toString()} data-state={position.withdrawn ? "withdrawn" : matured ? "matured" : "locked"}>
                    <div>
                      <strong>{formatAmount(position.amount)} NUSD</strong>
                      <small>#{id.toString()} · {option ? `${option.days}d ${option.multiplier}` : `${Math.round(position.lockDuration / 86_400)}d`} · {position.withdrawn ? "withdrawn" : `unlocks ${formatDate(position.unlockTime).slice(0, 10)}`}</small>
                    </div>
                    {position.withdrawn ? null : (
                      <button type="button" className="fi-button fi-button-muted" disabled={!matured || tx.pending} onClick={() => void withdraw(id)}>{matured ? "Withdraw" : "Locked"}</button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </article>
      </div>
    </section>
  );
}
