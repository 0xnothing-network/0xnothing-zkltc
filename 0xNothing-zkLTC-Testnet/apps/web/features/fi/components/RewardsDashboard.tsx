"use client";

import { useEffect, useMemo, useState } from "react";
import { formatUnits, type Address } from "viem";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
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

function formatShare(part: bigint | undefined, total: bigint | undefined): string {
  if (part === undefined || total === undefined) return "--";
  if (total === 0n) return "0%";
  return `${(Number((part * 1_000_000n) / total) / 10_000).toFixed(2)}%`;
}

export function RewardsDashboard() {
  const { address, isConnected } = useAccount();
  const toast = useToast();
  const tx = useProtocolTransaction();
  const [amountText, setAmountText] = useState("");
  const [duration, setDuration] = useState<number>(rewardLockOptions[0].duration);
  const [nowSeconds, setNowSeconds] = useState<number>();
  const staking = deployment.contracts.rewardStaking;
  const nusd = deployment.contracts.nusd;
  const amount = parseAmount(amountText);
  const selectedLock = rewardLockOptions.find((option) => option.duration === duration) ?? rewardLockOptions[0];

  useEffect(() => {
    const updateClock = () => setNowSeconds(Math.floor(Date.now() / 1000));
    updateClock();
    const timer = window.setInterval(updateClock, 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const pool = useReadContracts({
    contracts: staking ? [
      { address: staking, abi: rewardStakingAbi, functionName: "ROUND_REWARD" },
      { address: staking, abi: rewardStakingAbi, functionName: "availableRewards" },
      { address: staking, abi: rewardStakingAbi, functionName: "nextTriggerTime" },
      { address: staking, abi: rewardStakingAbi, functionName: "openRoundPoints" },
      { address: staking, abi: rewardStakingAbi, functionName: "currentRound" },
      { address: staking, abi: rewardStakingAbi, functionName: "totalPrincipal" },
    ] as const : [],
    query: { enabled: Boolean(staking), refetchInterval: REWARDS_POLL_MS, refetchIntervalInBackground: false },
  });
  const roundReward = pool.data?.[0]?.result as bigint | undefined;
  const available = pool.data?.[1]?.result as bigint | undefined;
  const nextTrigger = pool.data?.[2]?.result as bigint | undefined;
  const openRoundPoints = pool.data?.[3]?.result as bigint | undefined;
  const currentRound = pool.data?.[4]?.result as number | undefined;
  const totalPrincipal = pool.data?.[5]?.result as bigint | undefined;

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
  const [weight, openPoints, claimable] = account ?? [undefined, undefined, undefined];
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

  const roundStart = useReadContract({
    address: staking,
    abi: rewardStakingAbi,
    functionName: "roundStart",
    args: currentRound === undefined ? undefined : [BigInt(currentRound)],
    query: { enabled: Boolean(staking && currentRound !== undefined) },
  });

  const progress = available !== undefined && roundReward
    ? Math.min(1, Number((available * 10_000n) / roundReward) / 10_000)
    : 0;
  const poolReady = available !== undefined && roundReward !== undefined && available >= roundReward;
  const timeReady = nextTrigger !== undefined && nowSeconds !== undefined && BigInt(nowSeconds) >= nextTrigger;
  const canTrigger = poolReady && timeReady && Boolean(openRoundPoints && openRoundPoints > 0n);
  const estimatedReward = openPoints !== undefined && openRoundPoints && roundReward
    ? (openPoints * roundReward) / openRoundPoints
    : undefined;
  const previewWeight = amount ? (amount * BigInt(selectedLock.multiplierBps)) / 10_000n : undefined;
  const walletReady = !address || (walletNusd !== undefined && account !== undefined);
  const invalid = useMemo(() => {
    if (!amountText) return undefined;
    if (!amount) return "Enter a valid NUSD amount.";
    if (walletNusd !== undefined && amount > walletNusd) return "Amount exceeds your NUSD balance.";
    return undefined;
  }, [amount, amountText, walletNusd]);

  let closeHint = `Closes from ${formatDate(nextTrigger)} once the pool holds 10,000 NUSD`;
  if (canTrigger) closeHint = "Ready: anyone can close the round now";
  else if (poolReady && !timeReady) closeHint = `Pool full · closes from ${formatDate(nextTrigger)}`;
  else if (timeReady && !poolReady) closeHint = "Waiting for the pool to reach 10,000 NUSD";

  function refresh() {
    void pool.refetch();
    void wallet.refetch();
    void positionReads.refetch();
    void roundStart.refetch();
  }

  async function stake() {
    if (!amount || !staking || !nusd || invalid) return;
    const hash = await tx.execute({
      approval: { token: nusd, spender: staking, amount },
      call: { address: staking, abi: rewardStakingAbi, functionName: "stake", args: [amount, duration] },
    });
    if (hash) {
      toast.show("NUSD staked", `${selectedLock.days}-day lock at ${selectedLock.multiplier}. 0xPoints start accruing now.`, "success");
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
      toast.show("Rewards claimed", `${formatAmount(claimable)} NUSD sent to your wallet.`, "success");
      refresh();
    }
  }

  async function trigger() {
    if (!staking || !canTrigger) return;
    const hash = await tx.execute({ call: { address: staking, abi: rewardStakingAbi, functionName: "trigger" } });
    if (hash) {
      toast.show("Round closed", "10,000 NUSD was allocated to this round's 0xPoints. Stakers can claim now.", "success");
      refresh();
    }
  }

  if (!staking || !nusd) return <NotDeployed feature="0xPoints staking is not deployed on this network yet." />;

  return (
    <section className="fi-earn" aria-label="NUSD staking and 0xPoints rewards">
      <article className="fi-panel fi-round" aria-labelledby="rewards-round-title">
        <header className="fi-round-head">
          <div>
            <span className="fi-label">0xPoints rewards</span>
            <h2 id="rewards-round-title">Round {currentRound === undefined ? "--" : currentRound + 1}</h2>
          </div>
          <span className="fi-status" data-state={canTrigger ? "live" : "warning"}>{canTrigger ? "Ready to close" : "Filling"}</span>
          {canTrigger ? (
            <button type="button" className="fi-button fi-button-primary" disabled={!isConnected || tx.pending} onClick={() => void trigger()}>
              Close round
            </button>
          ) : null}
        </header>
        <div className="fi-pixel-progress" role="progressbar" aria-label="Reward pool toward 10,000 NUSD" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
          <span style={{ width: `${progress * 100}%` }} />
        </div>
        <p className="fi-round-caption">
          <strong>{formatAmount(available, 18, 2)}</strong> / {formatAmount(roundReward, 18, 0)} NUSD · {closeHint}
        </p>
        <dl className="fi-round-stats" aria-label="Your 0xPoints overview">
          <div>
            <dt>Your 0xPoints</dt>
            <dd>{formatPoints(openPoints)}<small>{formatShare(openPoints, openRoundPoints)} of round</small></dd>
          </div>
          <div>
            <dt>If closed now</dt>
            <dd>{formatAmount(estimatedReward, 18, 2)}<small>NUSD</small></dd>
          </div>
          <div>
            <dt>Claimable</dt>
            <dd data-tone="positive">{formatAmount(claimable, 18, 4)}<small>NUSD</small></dd>
            {claimable ? (
              <button type="button" className="fi-round-claim" disabled={tx.pending} onClick={() => void claim()}>Claim</button>
            ) : null}
          </div>
          <div>
            <dt>Total staked</dt>
            <dd>{formatAmount(totalPrincipal, 18, 2)}<small>NUSD</small></dd>
          </div>
        </dl>
        <details className="fi-round-help">
          <summary>How rounds work</summary>
          <ol>
            <li>Half of the NUSD fees from 0xPump and 0xFi fill the pool.</li>
            <li>0xPoints accrue every second: NUSD × lock multiplier. A last-minute stake earns almost nothing.</li>
            <li>At 10,000 NUSD (and at least a day), anyone closes the round; it is split by 0xPoints and points restart.</li>
            <li>Rewards never expire. Principal unlocks at maturity. Round opened {formatDate(roundStart.data)}.</li>
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
            <span>{previewWeight === undefined ? "--" : formatAmount(previewWeight, 18, 2)} 0xPoints / day</span>
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
