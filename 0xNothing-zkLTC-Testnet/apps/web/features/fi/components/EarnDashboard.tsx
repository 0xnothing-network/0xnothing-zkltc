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
import { nusdPointsStakingAbi, pointsLockOptions } from "@fi/lib/abis/points";
import { formatAmount, formatFixedAmount, parseAmount } from "@fi/lib/format";
import { useProtocolTransaction } from "@fi/lib/hooks/useProtocolTransaction";
import {
  POINTS_PER_XPOINT,
  isPublicPointsRedemptionAvailable,
  pointCreditsFromXPoints,
  quotePointsRedemption,
} from "@fi/lib/points";

const POSITION_PAGE_SIZE = 50n;
const EARN_POLL_MS = 10_000;
const SHOW_POINTS_REDEMPTION_UI = false;

type PointsPosition = {
  account: Address;
  amount: bigint;
  pointCredits: bigint;
  unlockTime: bigint;
  lockDuration: number;
  withdrawn: boolean;
};

function formatUnlock(unlockTime: bigint): string {
  return new Date(Number(unlockTime) * 1000).toISOString().slice(0, 10);
}

function formatPointCredits(value: bigint | undefined): string {
  return value === undefined ? "--" : `${formatFixedAmount(value, 20)}xPoints`;
}

function formatXPoints(value: bigint | undefined): string {
  return value === undefined ? "--" : `${formatFixedAmount(value)}xPoints`;
}

export function EarnDashboard() {
  const { address, isConnected } = useAccount();
  const toast = useToast();
  const tx = useProtocolTransaction();
  const redemptionTx = useProtocolTransaction();
  const [amountText, setAmountText] = useState("");
  const [redeemXPointsText, setRedeemXPointsText] = useState("");
  const [duration, setDuration] = useState<number>(pointsLockOptions[0].duration);
  const [nowSeconds, setNowSeconds] = useState<number>();
  const stakingAddress = deployment.contracts.nusdPointsStaking;
  const nusd = deployment.contracts.nusd;
  const amount = parseAmount(amountText);
  const redeemXPoints = parseAmount(redeemXPointsText);
  const redeemPointCredits = redeemXPoints === undefined
    ? undefined
    : pointCreditsFromXPoints(redeemXPoints);
  const selectedLock = pointsLockOptions.find((option) => option.duration === duration) ?? pointsLockOptions[0];
  const previewCredits = amount ? amount * BigInt(selectedLock.multiplierBps) / 10_000n : undefined;
  const previewXPoints = previewCredits === undefined ? undefined : previewCredits / POINTS_PER_XPOINT;

  useEffect(() => {
    const updateClock = () => setNowSeconds(Math.floor(Date.now() / 1000));
    updateClock();
    const timer = window.setInterval(updateClock, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const protocol = useReadContracts({
    contracts: stakingAddress ? [
      { address: stakingAddress, abi: nusdPointsStakingAbi, functionName: "totalLocked" },
      { address: stakingAddress, abi: nusdPointsStakingAbi, functionName: "stakingPaused" },
      { address: stakingAddress, abi: nusdPointsStakingAbi, functionName: "redemptionEnabled" },
      { address: stakingAddress, abi: nusdPointsStakingAbi, functionName: "redemptionsPaused" },
      { address: stakingAddress, abi: nusdPointsStakingAbi, functionName: "nusdPerXPointWad" },
      { address: stakingAddress, abi: nusdPointsStakingAbi, functionName: "redemptionReserve" },
      { address: stakingAddress, abi: nusdPointsStakingAbi, functionName: "isSolvent" },
    ] as const : [],
    query: { enabled: Boolean(stakingAddress), refetchInterval: EARN_POLL_MS, refetchIntervalInBackground: false },
  });
  const wallet = useReadContracts({
    contracts: address && stakingAddress && nusd ? [
      { address: nusd, abi: erc20Abi, functionName: "balanceOf", args: [address] },
      { address: stakingAddress, abi: nusdPointsStakingAbi, functionName: "totalLockedByUser", args: [address] },
      { address: stakingAddress, abi: nusdPointsStakingAbi, functionName: "earnedPointCredits", args: [address] },
      { address: stakingAddress, abi: nusdPointsStakingAbi, functionName: "spentPointCredits", args: [address] },
      { address: stakingAddress, abi: nusdPointsStakingAbi, functionName: "availablePointCredits", args: [address] },
      { address: stakingAddress, abi: nusdPointsStakingAbi, functionName: "userPositionCount", args: [address] },
    ] as const : [],
    query: { enabled: Boolean(address && stakingAddress && nusd), refetchInterval: EARN_POLL_MS, refetchIntervalInBackground: false },
  });

  const totalLocked = protocol.data?.[0]?.result as bigint | undefined;
  const stakingPaused = protocol.data?.[1]?.result as boolean | undefined;
  const redemptionEnabled = protocol.data?.[2]?.result as boolean | undefined;
  const redemptionsPaused = protocol.data?.[3]?.result as boolean | undefined;
  const nusdPerXPointWad = protocol.data?.[4]?.result as bigint | undefined;
  const redemptionReserve = protocol.data?.[5]?.result as bigint | undefined;
  const solvent = protocol.data?.[6]?.result as boolean | undefined;
  const walletNusd = wallet.data?.[0]?.result as bigint | undefined;
  const userLocked = wallet.data?.[1]?.result as bigint | undefined;
  const earnedCredits = wallet.data?.[2]?.result as bigint | undefined;
  const spentCredits = wallet.data?.[3]?.result as bigint | undefined;
  const availableCredits = wallet.data?.[4]?.result as bigint | undefined;
  const positionCount = wallet.data?.[5]?.result as bigint | undefined;
  const positionOffset = positionCount && positionCount > POSITION_PAGE_SIZE
    ? positionCount - POSITION_PAGE_SIZE
    : 0n;
  const publicRedemptionVisible = SHOW_POINTS_REDEMPTION_UI
    && isPublicPointsRedemptionAvailable({
      enabled: redemptionEnabled,
      paused: redemptionsPaused,
      nusdPerXPointWad,
      reserve: redemptionReserve,
      solvent,
    });
  const redeemQuote = redeemPointCredits !== undefined && nusdPerXPointWad !== undefined
    ? quotePointsRedemption(redeemPointCredits, nusdPerXPointWad)
    : undefined;

  const positionIdsRead = useReadContract({
    address: stakingAddress,
    abi: nusdPointsStakingAbi,
    functionName: "userPositionIds",
    args: address && positionCount !== undefined ? [address, positionOffset, POSITION_PAGE_SIZE] : undefined,
    query: {
      enabled: Boolean(address && stakingAddress && positionCount !== undefined && positionCount > 0n),
      refetchInterval: EARN_POLL_MS,
      refetchIntervalInBackground: false,
    },
  });
  const positionIds = positionIdsRead.data as readonly bigint[] | undefined;
  const positionReads = useReadContracts({
    contracts: (positionIds ?? []).map((positionId) => ({
      address: stakingAddress!,
      abi: nusdPointsStakingAbi,
      functionName: "getPosition" as const,
      args: [positionId] as const,
    })),
    query: {
      enabled: Boolean(stakingAddress && positionIds?.length),
      refetchInterval: EARN_POLL_MS,
      refetchIntervalInBackground: false,
    },
  });
  const positions = useMemo(() => {
    if (!positionIds) return [];
    return positionReads.data?.flatMap((read, index) => {
      if (read.status !== "success") return [];
      return [{ id: positionIds[index], position: read.result as PointsPosition }];
    }).reverse() ?? [];
  }, [positionIds, positionReads.data]);

  const walletReady = Boolean(
    !address || (
      walletNusd !== undefined
      && userLocked !== undefined
      && earnedCredits !== undefined
      && spentCredits !== undefined
      && availableCredits !== undefined
      && positionCount !== undefined
    ),
  );
  const invalid = useMemo(() => {
    if (!amountText) return undefined;
    if (!amount) return "Enter a valid NUSD amount.";
    if (walletNusd !== undefined && amount > walletNusd) return "Amount exceeds your NUSD balance.";
    if (stakingPaused) return "New stakes are paused.";
    return undefined;
  }, [amount, amountText, stakingPaused, walletNusd]);
  const redeemInvalid = useMemo(() => {
    if (!redeemXPointsText) return undefined;
    if (!redeemXPoints || !redeemPointCredits) return "Enter a valid xPoints amount.";
    if (availableCredits !== undefined && redeemPointCredits > availableCredits) {
      return "Amount exceeds your available xPoints.";
    }
    if (redeemQuote !== undefined && redeemQuote <= 0n) return "Amount is below the current redemption precision.";
    if (
      redemptionReserve !== undefined
      && redeemQuote !== undefined
      && redeemQuote > redemptionReserve
    ) {
      return "Amount exceeds the funded NUSD redemption reserve.";
    }
    return undefined;
  }, [availableCredits, redeemPointCredits, redeemQuote, redeemXPoints, redeemXPointsText, redemptionReserve]);

  function refresh() {
    void protocol.refetch();
    void wallet.refetch();
    void positionIdsRead.refetch();
    void positionReads.refetch();
  }

  async function stake() {
    if (!amount || !stakingAddress || !nusd || stakingPaused) return;
    const hash = await tx.execute({
      approval: { token: nusd, spender: stakingAddress, amount },
      call: {
        address: stakingAddress,
        abi: nusdPointsStakingAbi,
        functionName: "stake",
        args: [amount, duration],
      },
    });
    if (hash) {
      toast.show("NUSD staked", `${selectedLock.label} lock confirmed.`, "success");
      setAmountText("");
      refresh();
    }
  }

  async function withdraw(positionId: bigint) {
    if (!stakingAddress) return;
    const hash = await tx.execute({
      call: { address: stakingAddress, abi: nusdPointsStakingAbi, functionName: "withdraw", args: [positionId] },
    });
    if (hash) {
      toast.show("NUSD withdrawn", "The matured principal returned to your wallet.", "success");
      refresh();
    }
  }

  async function redeemPoints() {
    if (
      !stakingAddress
      || !redeemPointCredits
      || !redeemQuote
      || redeemInvalid
      || !publicRedemptionVisible
    ) return;
    const hash = await redemptionTx.execute({
      call: {
        address: stakingAddress,
        abi: nusdPointsStakingAbi,
        functionName: "redeemPoints",
        args: [redeemPointCredits],
      },
    });
    if (hash) {
      toast.show("xPoints redeemed", `${formatAmount(redeemQuote)} NUSD returned to your wallet.`, "success");
      setRedeemXPointsText("");
      refresh();
    }
  }

  if (!stakingAddress || !nusd) return <NotDeployed feature="NUSD staking and xPoints are prepared but not deployed yet." />;

  return (
    <section className="fi-points-dashboard" aria-label="NUSD staking and xPoints">
      <article className="fi-panel fi-points-overview" aria-labelledby="points-overview-title">
        <header className="fi-points-overview-copy">
          <div className="fi-points-kicker-row">
            <span className="fi-label">NUSD staking</span>
            <span className="fi-status" data-state={stakingPaused ? "warning" : "live"}>{stakingPaused ? "Paused" : "Active"}</span>
          </div>
          <h2 id="points-overview-title">Earn xPoints</h2>
          <p>1 NUSD earns 0.01xPoints at x1. Lock for 30 to 365 days to earn up to x3.</p>
        </header>
        <dl className="fi-points-metrics" aria-label="Your NUSD staking overview">
          <div><dt>Your locked NUSD</dt><dd>{formatAmount(userLocked)} <small>NUSD</small></dd></div>
          <div><dt>Available xPoints</dt><dd data-tone="positive">{formatPointCredits(availableCredits)}</dd></div>
        </dl>
        <details className="fi-points-program-details">
          <summary>Program details</summary>
          <div>
            <dl aria-label="NUSD staking program details">
              <div><dt>Total NUSD locked</dt><dd>{formatAmount(totalLocked)} NUSD</dd></div>
              <div><dt>Your earned xPoints</dt><dd>{formatPointCredits(earnedCredits)}</dd></div>
            </dl>
            <p>NUSD is held in 100% on-chain escrow until maturity. xPoints are non-transferable.</p>
          </div>
        </details>
      </article>

      <div className="fi-points-workspace">
        <article className="fi-panel fi-points-stake-card" data-program-state={stakingPaused ? "ended" : "active"} aria-labelledby="points-stake-title">
          <header className="fi-points-card-heading">
            <div><span className="fi-label">New position</span><h2 id="points-stake-title">Stake NUSD</h2></div>
          </header>
          <div className="fi-points-stake-form">
            <div className="fi-points-lock-field">
              <span className="fi-label">Lock period</span>
              <div className="fi-segmented fi-points-locks" role="group" aria-label="Lock duration">
                {pointsLockOptions.map((option) => (
                  <button type="button" className={duration === option.duration ? "active positive" : ""} aria-pressed={duration === option.duration} disabled={tx.pending || redemptionTx.pending} onClick={() => { setDuration(option.duration); tx.reset(); }} key={option.duration}>
                    <span>{option.days}d</span><strong>{option.multiplier}</strong>
                  </button>
                ))}
              </div>
            </div>
            <AmountField id="points-stake-nusd" label="Amount" asset="NUSD" value={amountText} balance={formatAmount(walletNusd)} helper="Your NUSD principal unlocks only at maturity." error={invalid} onChange={setAmountText} onMax={walletNusd && walletNusd > 0n ? () => setAmountText(formatUnits(walletNusd, 18)) : undefined} />
            <dl className="fi-points-estimate" aria-label="NUSD stake estimate">
              <div><dt>Estimated xPoints</dt><dd data-tone="positive">{formatXPoints(previewXPoints)}</dd></div>
              <div><dt>Unlock date</dt><dd>{amount && nowSeconds ? formatUnlock(BigInt(nowSeconds + duration)) : "--"}</dd></div>
            </dl>
            {!isConnected ? <ConnectWalletButton /> : (
              <button type="button" className="fi-button fi-button-block fi-button-primary" disabled={!walletReady || !amount || Boolean(invalid) || Boolean(stakingPaused) || tx.pending || redemptionTx.pending} onClick={() => void stake()}>
                {tx.pending ? "Processing" : stakingPaused ? "New stakes paused" : `Stake for ${selectedLock.days} days`}
              </button>
            )}
            <TransactionStatus phase={tx.phase} message={tx.message} hash={tx.hash} />
          </div>
        </article>

        <aside className="fi-points-account" aria-label="Your NUSD staking account">
          <article className="fi-panel fi-points-positions" aria-labelledby="points-positions-title">
            <header className="fi-points-card-heading">
              <div><span className="fi-label">Your positions</span><h2 id="points-positions-title">NUSD locks</h2></div>
              <span className="fi-points-count" aria-label={`${positionCount === undefined ? "Unknown" : positionCount.toString()} positions`}>{positionCount === undefined ? "--" : positionCount.toString()}</span>
            </header>
            {positionCount && positionCount > POSITION_PAGE_SIZE ? <div className="fi-inline-state fi-inline-warning" role="status">Showing the latest {POSITION_PAGE_SIZE.toString()} positions. All positions remain queryable on-chain.</div> : null}
            {!isConnected ? <div className="fi-points-connect"><p>Connect your wallet above to view active locks and maturity dates.</p></div> : positions.length === 0 ? (
              <div className="fi-empty-state fi-points-empty-state"><h2>No NUSD locks yet</h2><p>Your confirmed positions will appear here without refreshing the page.</p></div>
            ) : (
              <div className="fi-points-position-list">
                {positions.map(({ id, position }) => {
                  const matured = nowSeconds !== undefined && BigInt(nowSeconds) >= position.unlockTime;
                  const option = pointsLockOptions.find((item) => item.duration === position.lockDuration);
                  return (
                    <div className="fi-points-position" key={id.toString()}>
                      <div className="fi-points-position-copy">
                        <span className="fi-label">Position #{id.toString()}</span>
                        <strong>{formatAmount(position.amount)} NUSD</strong>
                        <small>{option?.label ?? `${Math.round(position.lockDuration / 86_400)} days`} · {formatPointCredits(position.pointCredits)} · unlock {formatUnlock(position.unlockTime)}</small>
                      </div>
                      <span className="fi-status" data-state={position.withdrawn ? "offline" : matured ? "live" : "warning"}>{position.withdrawn ? "Withdrawn" : matured ? "Matured" : "Locked"}</span>
                      <button type="button" className="fi-button fi-button-muted" disabled={position.withdrawn || !matured || tx.pending || redemptionTx.pending} onClick={() => void withdraw(id)}>{position.withdrawn ? "Withdrawn" : matured ? "Withdraw NUSD" : "Still locked"}</button>
                    </div>
                  );
                })}
              </div>
            )}
          </article>
        </aside>
      </div>

      {publicRedemptionVisible ? (
        <article className="fi-panel fi-points-redemption" data-program-state="active" aria-labelledby="points-redemption-title">
          <header className="fi-points-card-heading">
            <div><span className="fi-label">Funded on-chain</span><h2 id="points-redemption-title">Redeem xPoints</h2></div>
            <span className="fi-status" data-state="live">Available</span>
          </header>
          <div className="fi-points-redemption-body">
            <div className="fi-points-redemption-action">
              <AmountField
                id="points-redeem-xpoints"
                label="Redeem"
                asset="xPoints"
                value={redeemXPointsText}
                balance={availableCredits === undefined ? "--" : formatFixedAmount(availableCredits, 20)}
                helper="Redeemed xPoints are permanently deducted when NUSD returns to your wallet."
                error={redeemInvalid}
                onChange={(value) => { setRedeemXPointsText(value); redemptionTx.reset(); }}
                onMax={availableCredits && availableCredits >= POINTS_PER_XPOINT
                  ? () => setRedeemXPointsText(formatUnits(availableCredits, 20))
                  : undefined}
              />
              {!isConnected ? <ConnectWalletButton /> : (
                <button
                  type="button"
                  className="fi-button fi-button-block fi-button-primary"
                  disabled={!walletReady || !redeemPointCredits || Boolean(redeemInvalid) || tx.pending || redemptionTx.pending}
                  onClick={() => void redeemPoints()}
                >
                  {redemptionTx.pending ? "Processing" : "Redeem for NUSD"}
                </button>
              )}
              <TransactionStatus phase={redemptionTx.phase} message={redemptionTx.message} hash={redemptionTx.hash} />
            </div>
            <dl className="fi-points-redemption-quote" aria-label="xPoints redemption quote">
              <div><dt>You receive</dt><dd data-tone="positive">{formatAmount(redeemQuote, 18, 6)} NUSD</dd></div>
              <div><dt>Rate</dt><dd>{formatAmount(nusdPerXPointWad, 18, 6)} NUSD / xPoints</dd></div>
              <div><dt>NUSD reserve</dt><dd>{formatAmount(redemptionReserve)} NUSD</dd></div>
            </dl>
          </div>
        </article>
      ) : null}
    </section>
  );
}
