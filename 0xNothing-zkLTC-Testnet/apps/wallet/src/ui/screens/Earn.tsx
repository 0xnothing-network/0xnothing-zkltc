import { type ReactNode, useEffect, useState } from "react";
import { formatUnits } from "viem";
import { NUSD_TOKEN } from "../../config/assets";
import { txUrl } from "../../config/chain";
import { t } from "../../core/i18n";
import { describeError } from "../../core/lib/errors";
import { formatAmount, formatBalance, parseAmount } from "../../core/lib/format";
import {
  claimPointsRewards,
  formatPoints,
  formatPointsPerDay,
  POINTS_LOCK_OPTIONS,
  dailyReward,
  loadPointsState,
  rewardShareBps,
  stakeNusdForPoints,
  stakeWeight,
  type PointsPosition,
  withdrawPointsStake,
} from "../../core/services/points";
import { loadPortfolio } from "../../core/services/portfolio";
import { AmountField } from "../components/AmountField";
import { TransactionReview } from "../components/TransactionReview";
import { Button, Empty, Note, Panel, PanelBody, Row, Rows } from "../components/kit";
import { Screen } from "../components/Screen";
import { useActionGate } from "../hooks/useActionGate";
import { useLiveRead } from "../hooks/useLiveRead";
import { reviewKey } from "../lib/reviewKey";
import { goHome, navigate } from "../router";
import { useWallet } from "../state/WalletContext";

type ReviewAction =
  | {
    kind: "stake";
    identity: string;
    amount: bigint;
    lockDuration: number;
    days: number;
    multiplierBps: number;
  }
  | {
    kind: "withdraw";
    identity: string;
    positionId: bigint;
    amount: bigint;
  }
  | {
    kind: "claim";
    identity: string;
    amount: bigint;
  };

function multiplierLabel(multiplierBps: number): string {
  return (multiplierBps / 10_000).toFixed(2).replace(/\.00$/u, "").replace(/0$/u, "");
}

function lockDays(duration: number): number {
  return Math.floor(duration / 86_400);
}

function unlockLabel(unlockTime: bigint): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(Number(unlockTime) * 1_000);
}

function unlockDateLabel(unlockTime: bigint): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" })
    .format(Number(unlockTime) * 1_000);
}

export function Earn(): ReactNode {
  const { address, tokens, network, notify, refresh, tick } = useWallet();
  const [amount, setAmount] = useState("");
  const [lockDuration, setLockDuration] = useState(POINTS_LOCK_OPTIONS[0]!.duration);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewAction | null>(null);
  const confirmGate = useActionGate();

  const read = useLiveRead(
    address
      ? async () => {
          const [state, portfolio] = await Promise.all([
            loadPointsState(address),
            loadPortfolio(address, tokens),
          ]);
          return { state, portfolio };
        }
      : null,
    [address, network.id, network.rpcUrl, tokens, tick],
    { identity: [address, network.id, network.rpcUrl, tokens] },
  );
  const state = read.data?.state ?? null;
  const walletNusd =
    read.data?.portfolio.rows.find((row) => row.token.id === NUSD_TOKEN.id)?.balance ?? null;

  const parsed = parseAmount(amount, NUSD_TOKEN.decimals);
  const positive = parsed !== null && parsed > 0n;
  const overWallet = parsed !== null && walletNusd !== null && parsed > walletNusd;
  const stakeReady = address !== null
    && state !== null
    && walletNusd !== null
    && positive
    && !overWallet;
  const amountInvalid = amount.length > 0 && (!positive || overWallet);
  const selectedLock = POINTS_LOCK_OPTIONS.find((option) => option.duration === lockDuration)
    ?? POINTS_LOCK_OPTIONS[0]!;
  const stakeIdentity = reviewKey([
    address,
    network.id,
    network.rpcUrl,
    "stake",
    amount,
    parsed,
    lockDuration,
  ]);

  const claimIdentity = reviewKey([address, network.id, network.rpcUrl, "claim", state?.claimable]);
  const claimReady = address !== null && state !== null && state.claimable > 0n;
  const now = BigInt(Math.floor(Date.now() / 1_000));
  const estimatedDailyPoints = parsed !== null && parsed > 0n
    ? stakeWeight(parsed, selectedLock.multiplierBps)
    : null;
  const estimatedUnlockTime = parsed !== null && parsed > 0n
    ? now + BigInt(selectedLock.duration)
    : null;

  useEffect(() => {
    setReview(null);
  }, [address, amount, lockDuration, network.id, network.rpcUrl]);

  const fillStakeMax = (): void => {
    if (walletNusd === null) return;
    setAmount(formatUnits(walletNusd, NUSD_TOKEN.decimals));
  };

  const openStakeReview = (): void => {
    if (busy || !stakeReady || parsed === null) return;
    setError(null);
    setReview({
      kind: "stake",
      identity: stakeIdentity,
      amount: parsed,
      lockDuration: selectedLock.duration,
      days: lockDays(selectedLock.duration),
      multiplierBps: selectedLock.multiplierBps,
    });
  };

  const openWithdrawReview = (position: PointsPosition): void => {
    const mature = !position.withdrawn && now >= position.unlockTime;
    if (busy || !mature || address === null) return;
    setError(null);
    setReview({
      kind: "withdraw",
      identity: reviewKey([
        address,
        network.id,
        network.rpcUrl,
        "withdraw",
        position.id,
        position.amount,
        position.unlockTime,
        position.withdrawn,
      ]),
      positionId: position.id,
      amount: position.amount,
    });
  };

  const openClaimReview = (): void => {
    if (busy || !claimReady || state === null) return;
    setError(null);
    setReview({ kind: "claim", identity: claimIdentity, amount: state.claimable });
  };

  const reviewedPosition = review?.kind === "withdraw"
    ? state?.positions.find((position) => position.id === review.positionId) ?? null
    : null;
  const reviewReady = review === null
    ? false
    : review.kind === "stake"
      ? review.identity === stakeIdentity && stakeReady && review.amount === parsed
      : review.kind === "claim"
        ? review.identity === claimIdentity && claimReady && review.amount === state?.claimable
        : reviewedPosition !== null
          && review.identity === reviewKey([
            address,
            network.id,
            network.rpcUrl,
            "withdraw",
            reviewedPosition.id,
            reviewedPosition.amount,
            reviewedPosition.unlockTime,
            reviewedPosition.withdrawn,
          ])
          && !reviewedPosition.withdrawn
          && now >= reviewedPosition.unlockTime;

  const confirm = async (): Promise<void> => {
    if (
      busy
      || review === null
      || !reviewReady
      || address === null
      || !confirmGate.tryEnter()
    ) return;
    const submitted = review;
    const submittedNetwork = network;
    setBusy(true);
    setError(null);
    try {
      if (submitted.kind === "stake") {
        const hash = await stakeNusdForPoints({
          from: address,
          amount: submitted.amount,
          lockDuration: submitted.lockDuration,
        });
        notify(
          t("earn.toastStake", {
            amount: formatAmount(submitted.amount, NUSD_TOKEN.decimals, 6),
            days: submitted.days,
          }),
          "ok",
          txUrl(hash, submittedNetwork),
        );
        setAmount("");
      } else if (submitted.kind === "withdraw") {
        const hash = await withdrawPointsStake({ from: address, positionId: submitted.positionId });
        notify(
          t("earn.toastWithdraw", {
            amount: formatAmount(submitted.amount, NUSD_TOKEN.decimals, 6),
          }),
          "ok",
          txUrl(hash, submittedNetwork),
        );
      } else {
        const hash = await claimPointsRewards({ from: address, amount: submitted.amount });
        notify(
          t("earn.toastClaim", { amount: formatAmount(submitted.amount, NUSD_TOKEN.decimals, 6) }),
          "ok",
          txUrl(hash, submittedNetwork),
        );
      }
      setReview(null);
      refresh();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      confirmGate.leave();
      setBusy(false);
    }
  };

  const reviewTitle = review?.kind === "stake"
    ? t("earn.reviewStake")
    : review?.kind === "withdraw"
      ? t("earn.reviewWithdraw")
      : t("earn.reviewClaim");
  const reviewConfirm = review?.kind === "stake"
    ? t("earn.submitStake")
    : review?.kind === "withdraw"
      ? t("earn.withdraw")
      : t("earn.claim");

  return (
    <Screen title={t("earn.title")} onBack={goHome}>
      <form
        className="w-flow w-earn-flow"
        aria-busy={busy || read.loading}
        onSubmit={(event) => {
          event.preventDefault();
          openStakeReview();
        }}
      >
        <div className="w-flow-main">
          <AmountField
            label={t("earn.stakeLabel")}
            value={amount}
            invalid={amountInvalid}
            disabled={busy}
            onChange={(next) => {
              setAmount(next);
              setError(null);
            }}
            symbol={NUSD_TOKEN.symbol}
            onMax={walletNusd === null ? undefined : fillStakeMax}
            hint={walletNusd === null
              ? t("send.readingBalance")
              : t("lend.hintWallet", {
                amount: formatBalance(walletNusd, NUSD_TOKEN.decimals),
                symbol: NUSD_TOKEN.symbol,
              })}
          />
          <div className="w-field">
            <span className="w-label">{t("earn.lockPeriod")}</span>
            <div className="w-earn-locks" role="group" aria-label={t("earn.lockPeriod")}>
              {POINTS_LOCK_OPTIONS.map((option) => (
                <button
                  key={option.duration}
                  type="button"
                  className="w-earn-lock-option"
                  aria-label={t("earn.lockOption", {
                    days: lockDays(option.duration),
                    multiplier: multiplierLabel(option.multiplierBps),
                  })}
                  aria-pressed={lockDuration === option.duration}
                  disabled={busy}
                  onClick={() => {
                    setLockDuration(option.duration);
                    setError(null);
                  }}
                >
                  <span aria-hidden="true">{lockDays(option.duration)}d</span>
                  <strong aria-hidden="true">x{multiplierLabel(option.multiplierBps)}</strong>
                </button>
              ))}
            </div>
          </div>
          <dl className="w-earn-estimate" aria-label={t("earn.stake")}>
            <div>
              <dt>{t("earn.pointsPerDay")}</dt>
              <dd data-tone="green">
                {estimatedDailyPoints === null ? "—" : formatPointsPerDay(estimatedDailyPoints)}
              </dd>
            </div>
            <div>
              <dt>{t("earn.unlocks")}</dt>
              <dd>{estimatedUnlockTime === null ? "—" : unlockDateLabel(estimatedUnlockTime)}</dd>
            </div>
          </dl>
          <Panel>
            <Rows>
              <Row
                label={t("earn.locked")}
                value={state === null
                  ? "…"
                  : `${formatAmount(state.totalLocked, NUSD_TOKEN.decimals, 4)} NUSD`}
                tone="green"
              />
              <Row
                label={t("earn.points")}
                value={state === null ? "…" : formatPoints(state.points)}
                tone="green"
              />
              <Row
                label={t("earn.rewardShare")}
                value={state === null
                  ? "…"
                  : `${(rewardShareBps(state.weight, state.totalWeight) / 100).toFixed(2)}%`}
              />
              <Row
                label={t("earn.yourDaily")}
                value={state === null
                  ? "…"
                  : `${formatAmount(dailyReward(state.rewardRate, state.weight, state.totalWeight), NUSD_TOKEN.decimals, 4)} NUSD`}
                tone="green"
              />
              <Row
                label={t("earn.stream")}
                value={state === null
                  ? "…"
                  : state.rewardRate > 0n
                    ? `${formatAmount(state.rewardRate * 86_400n, NUSD_TOKEN.decimals, 2)} NUSD`
                    : `${formatAmount(state.queued, NUSD_TOKEN.decimals, 2)} NUSD`}
              />
              <Row
                label={t("earn.claimable")}
                value={state === null
                  ? "…"
                  : `${formatAmount(state.claimable, NUSD_TOKEN.decimals, 4)} NUSD`}
                tone="green"
              />
            </Rows>
            {state !== null && state.claimable > 0n ? (
              <PanelBody>
                <Button type="button" variant="primary" block disabled={busy || !claimReady} onClick={openClaimReview}>
                  {t("earn.claim")}
                </Button>
              </PanelBody>
            ) : null}
          </Panel>
          {overWallet ? <Note tone="error">{t("earn.overWallet")}</Note> : null}
          {read.error !== null ? <Note tone="error">{read.error}</Note> : null}
          <Note>{t("earn.stakeNote")}</Note>
        </div>
        <div className="w-flow-actions">
          {error !== null ? <Note tone="error">{error}</Note> : null}
          <Button type="submit" variant="primary" block disabled={busy || !stakeReady}>
            {busy || read.loading ? t("common.working") : t("earn.submitStake")}
          </Button>
        </div>
      </form>

      <div className="w-stack">
        <span className="w-label">{t("earn.positions")}</span>
        {state?.positionsTruncated === true ? (
          <Note tone="warn">
            {t("earn.positionsTruncated", { count: state.positionCount.toString() })}
          </Note>
        ) : null}
        {state === null && read.loading ? (
          <Empty>{t("common.working")}</Empty>
        ) : state === null || state.positions.length === 0 ? (
          <Empty>{t("earn.noPositions")}</Empty>
        ) : (
          state.positions.map((position) => {
            const mature = !position.withdrawn && now >= position.unlockTime;
            return (
              <Panel key={position.id.toString()} title={t("earn.position", { id: position.id.toString() })}>
                <PanelBody>
                  <Rows>
                    <Row
                      label={t("earn.positionAmount")}
                      value={`${formatAmount(position.amount, NUSD_TOKEN.decimals, 4)} NUSD`}
                    />
                    <Row
                      label={t("earn.pointsPerDay")}
                      value={position.withdrawn ? "—" : formatPointsPerDay(position.weight)}
                      tone="green"
                    />
                    <Row label={t("earn.unlocks")} value={unlockLabel(position.unlockTime)} />
                    {position.withdrawn ? (
                      <Row label={t("earn.withdrawn")} value={t("common.yes")} tone="dim" />
                    ) : null}
                  </Rows>
                  {mature ? (
                    <Button
                      type="button"
                      variant="primary"
                      block
                      disabled={busy}
                      onClick={() => openWithdrawReview(position)}
                    >
                      {t("earn.withdraw")}
                    </Button>
                  ) : null}
                </PanelBody>
              </Panel>
            );
          })
        )}
      </div>

      <Panel title={t("earn.lending")}>
        <PanelBody>
          <Note>{t("earn.lendingNote")}</Note>
          <Button type="button" block onClick={() => navigate("#/lend")}>
            {t("earn.lending")}
          </Button>
        </PanelBody>
      </Panel>

      {review !== null ? (
        <TransactionReview
          title={reviewTitle}
          busy={busy}
          ready={reviewReady}
          confirmLabel={reviewConfirm}
          onClose={() => setReview(null)}
          onConfirm={() => void confirm()}
          hero={
            <div className="w-summary">
              <span className="w-summary-label">
                {review.kind === "stake"
                  ? t("earn.stake")
                  : review.kind === "withdraw"
                    ? t("earn.withdraw")
                    : t("earn.claim")}
              </span>
              <span className="w-summary-value">
                {`${formatAmount(review.amount, NUSD_TOKEN.decimals, 6)} NUSD`}
              </span>
            </div>
          }
        >
          <Panel>
            <Rows>
              {review.kind === "stake" ? (
                <>
                  <Row
                    label={t("earn.lockPeriod")}
                    value={t("earn.lockOption", {
                      days: review.days,
                      multiplier: multiplierLabel(review.multiplierBps),
                    })}
                  />
                  <Row
                    label={t("earn.pointsPerDay")}
                    value={formatPointsPerDay(stakeWeight(review.amount, review.multiplierBps))}
                    tone="green"
                  />
                  <Row label={t("common.network")} value={network.name} />
                </>
              ) : review.kind === "withdraw" ? (
                <>
                  <Row label={t("earn.position")} value={`#${review.positionId.toString()}`} />
                  <Row label={t("common.network")} value={network.name} />
                </>
              ) : (
                <>
                  <Row
                    label={t("earn.claimable")}
                    value={`${formatAmount(review.amount, NUSD_TOKEN.decimals, 6)} NUSD`}
                    tone="green"
                  />
                  <Row label={t("common.network")} value={network.name} />
                </>
              )}
            </Rows>
          </Panel>
          {review.kind === "stake" ? <Note>{t("earn.approvalHint")}</Note> : null}
          {error !== null ? <Note tone="error">{error}</Note> : null}
        </TransactionReview>
      ) : null}
    </Screen>
  );
}
