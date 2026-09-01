import { type ReactNode, useEffect, useState } from "react";
import { formatUnits } from "viem";
import { NUSD_TOKEN } from "../../config/assets";
import { txUrl } from "../../config/chain";
import { t } from "../../core/i18n";
import { describeError } from "../../core/lib/errors";
import { formatAmount, formatBalance, parseAmount } from "../../core/lib/format";
import {
  formatPointCredits,
  formatXPoints,
  POINTS_LOCK_OPTIONS,
  loadPointsState,
  pointCreditsToXPoints,
  redeemXPoints,
  stakeNusdForPoints,
  type PointsPosition,
  withdrawPointsStake,
  xPointsToPointCredits,
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

const SHOW_POINTS_REDEMPTION_UI = false;

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
    kind: "redeem";
    identity: string;
    pointCredits: bigint;
    xPointsWad: bigint;
    nusdOut: bigint;
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
  const [redeemAmount, setRedeemAmount] = useState("");
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
    && !overWallet
    && !state.stakingPaused;
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

  const availableXPointsWad = state === null
    ? null
    : pointCreditsToXPoints(state.availablePointCredits);
  const parsedXPointsWad = parseAmount(redeemAmount, 18);
  const redeemPointCredits = parsedXPointsWad === null
    ? null
    : xPointsToPointCredits(parsedXPointsWad);
  const redeemPositive = parsedXPointsWad !== null && parsedXPointsWad > 0n;
  const overPoints = redeemPointCredits !== null
    && state !== null
    && redeemPointCredits > state.availablePointCredits;
  const redemptionVisible = SHOW_POINTS_REDEMPTION_UI
    && state !== null
    && state.redemptionVisible
    && state.redemptionEnabled
    && !state.redemptionsPaused
    && state.nusdPerXPointWad > 0n
    && state.redemptionReserve > 0n
    && state.solvent;
  const redeemQuote = parsedXPointsWad === null || state === null
    ? null
    : (parsedXPointsWad * state.nusdPerXPointWad) / 10n ** 18n;
  const redeemReady = address !== null
    && redemptionVisible
    && redeemPositive
    && redeemPointCredits !== null
    && !overPoints
    && redeemQuote !== null
    && redeemQuote > 0n
    && redeemQuote <= state.redemptionReserve;
  const redeemInvalid = redeemAmount.length > 0 && (!redeemPositive || overPoints);
  const redeemTooSmall = redemptionVisible && redeemPositive && redeemQuote === 0n;
  const redeemOverReserve = redemptionVisible
    && redeemQuote !== null
    && state !== null
    && redeemQuote > state.redemptionReserve;
  const redeemIdentity = reviewKey([
    address,
    network.id,
    network.rpcUrl,
    "redeem",
    redeemAmount,
    parsedXPointsWad,
    redeemPointCredits,
    redeemQuote,
    state?.nusdPerXPointWad,
    state?.redemptionReserve,
  ]);
  const now = BigInt(Math.floor(Date.now() / 1_000));
  const estimatedPointCredits = parsed !== null && parsed > 0n
    ? (parsed * BigInt(selectedLock.multiplierBps)) / 10_000n
    : null;
  const estimatedUnlockTime = parsed !== null && parsed > 0n
    ? now + BigInt(selectedLock.duration)
    : null;

  useEffect(() => {
    setReview(null);
  }, [address, amount, lockDuration, network.id, network.rpcUrl, redeemAmount]);

  useEffect(() => {
    if (!redemptionVisible && review?.kind === "redeem") setReview(null);
  }, [redemptionVisible, review?.kind]);

  const fillStakeMax = (): void => {
    if (walletNusd === null) return;
    setAmount(formatUnits(walletNusd, NUSD_TOKEN.decimals));
  };

  const fillRedeemMax = (): void => {
    if (availableXPointsWad === null) return;
    setRedeemAmount(formatUnits(availableXPointsWad, 18));
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

  const openRedeemReview = (): void => {
    if (
      busy
      || !redeemReady
      || redeemPointCredits === null
      || parsedXPointsWad === null
      || redeemQuote === null
    ) return;
    setError(null);
    setReview({
      kind: "redeem",
      identity: redeemIdentity,
      pointCredits: redeemPointCredits,
      xPointsWad: parsedXPointsWad,
      nusdOut: redeemQuote,
    });
  };

  const reviewedPosition = review?.kind === "withdraw"
    ? state?.positions.find((position) => position.id === review.positionId) ?? null
    : null;
  const reviewReady = review === null
    ? false
    : review.kind === "stake"
      ? review.identity === stakeIdentity && stakeReady && review.amount === parsed
      : review.kind === "redeem"
        ? review.identity === redeemIdentity
          && redeemReady
          && review.pointCredits === redeemPointCredits
          && review.nusdOut === redeemQuote
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
        const hash = await redeemXPoints({ from: address, pointCredits: submitted.pointCredits });
        notify(
          t("earn.toastRedeem", {
            points: formatXPoints(submitted.xPointsWad),
            amount: formatAmount(submitted.nusdOut, NUSD_TOKEN.decimals, 6),
          }),
          "ok",
          txUrl(hash, submittedNetwork),
        );
        setRedeemAmount("");
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
      : t("earn.reviewRedeem");
  const reviewConfirm = review?.kind === "stake"
    ? t("earn.submitStake")
    : review?.kind === "withdraw"
      ? t("earn.withdraw")
      : t("earn.redeemSubmit");

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
              <dt>{t("earn.positionPoints")}</dt>
              <dd data-tone="green">
                {estimatedPointCredits === null ? "—" : formatPointCredits(estimatedPointCredits)}
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
                label={t("earn.availablePoints")}
                value={state === null ? "…" : formatPointCredits(state.availablePointCredits)}
                tone="green"
              />
            </Rows>
          </Panel>
          {overWallet ? <Note tone="error">{t("earn.overWallet")}</Note> : null}
          {state?.stakingPaused === true ? (
            <Note tone="error">{t("earn.stakingPaused")}</Note>
          ) : null}
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
                      label={t("earn.positionPoints")}
                      value={formatPointCredits(position.pointCredits)}
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

      {redemptionVisible ? (
        <form
          className="w-flow"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            openRedeemReview();
          }}
        >
          <div className="w-flow-main">
            <AmountField
              label={t("earn.redeemLabel")}
              value={redeemAmount}
              invalid={redeemInvalid}
              disabled={busy}
              onChange={(next) => {
                setRedeemAmount(next);
                setError(null);
              }}
              symbol="xPoints"
              onMax={availableXPointsWad === null ? undefined : fillRedeemMax}
              hint={state === null
                ? undefined
                : formatPointCredits(state.availablePointCredits)}
            />
            <Panel title={t("earn.redeem")}>
              <Rows>
                <Row
                  label={t("earn.redeemRate")}
                  value={`${formatAmount(state.nusdPerXPointWad, 18, 6)} NUSD`}
                />
                <Row
                  label={t("earn.redeemReceive")}
                  value={redeemQuote === null
                    ? "—"
                    : `${formatAmount(redeemQuote, NUSD_TOKEN.decimals, 6)} NUSD`}
                  tone="green"
                />
              </Rows>
            </Panel>
            {overPoints ? <Note tone="error">{t("earn.overPoints")}</Note> : null}
            {redeemTooSmall ? <Note tone="error">{t("earn.redeemTooSmall")}</Note> : null}
            {redeemOverReserve ? <Note tone="error">{t("earn.redeemReserve")}</Note> : null}
          </div>
          <div className="w-flow-actions">
            <Button type="submit" variant="primary" block disabled={busy || !redeemReady}>
              {busy ? t("common.working") : t("earn.redeemSubmit")}
            </Button>
          </div>
        </form>
      ) : null}

      <Panel title={t("earn.lending")}>
        <PanelBody>
          <Note>{t("earn.lendingNote")}</Note>
          <Button type="button" block onClick={() => navigate("#/lend")}>
            {t("earn.lending")}
          </Button>
        </PanelBody>
      </Panel>

      {review !== null && (review.kind !== "redeem" || redemptionVisible) ? (
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
                    : t("earn.redeem")}
              </span>
              <span className="w-summary-value">
                {review.kind === "stake" || review.kind === "withdraw"
                  ? `${formatAmount(review.amount, NUSD_TOKEN.decimals, 6)} NUSD`
                  : formatXPoints(review.xPointsWad)}
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
                    label={t("earn.positionPoints")}
                    value={formatPointCredits(
                      (review.amount * BigInt(review.multiplierBps)) / 10_000n,
                    )}
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
                    label={t("earn.redeemReceive")}
                    value={`${formatAmount(review.nusdOut, NUSD_TOKEN.decimals, 6)} NUSD`}
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
