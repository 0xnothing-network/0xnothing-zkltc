import { type ReactNode, useEffect, useState } from "react";
import { formatUnits } from "viem";
import { NUSD_TOKEN } from "../../config/assets";
import { txUrl } from "../../config/chain";
import { t } from "../../core/i18n";
import { describeError } from "../../core/lib/errors";
import {
  formatAmount,
  formatBalance,
  formatRateWad,
  parseAmount,
} from "../../core/lib/format";
import { loadLendState, supplyNusd, withdrawNusd } from "../../core/services/lend";
import { loadPortfolio } from "../../core/services/portfolio";
import { AmountField } from "../components/AmountField";
import { Button, Note, Panel, Row, Rows } from "../components/kit";
import { Screen } from "../components/Screen";
import { useActionGate } from "../hooks/useActionGate";
import { useLiveRead } from "../hooks/useLiveRead";
import { reviewKey } from "../lib/reviewKey";
import { goHome } from "../router";
import { useWallet } from "../state/WalletContext";

/**
 * The wireframe's "STAKE NUSD". It is the 0xFi lending pool — supply() earns the
 * lender share of borrower interest — so the screen says pool rather than stake:
 * there is no staking contract to point at, and pretending otherwise would hide
 * that the yield comes from borrowers and that withdrawals depend on liquidity.
 */
type Mode = "supply" | "withdraw";

export function Lend(): ReactNode {
  const { address, tokens, network, notify, refresh, tick } = useWallet();
  const [mode, setMode] = useState<Mode>("supply");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewIdentity, setReviewIdentity] = useState<string | null>(null);
  const confirmGate = useActionGate();

  const read = useLiveRead(
    address
      ? async () => {
          const [state, portfolio] = await Promise.all([
            loadLendState(address),
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
  const supply = mode === "supply";
  // Supplying is capped by the wallet, withdrawing by what borrowers left behind.
  const cap = supply ? walletNusd : (state?.maxWithdraw ?? null);

  const parsed = parseAmount(amount, NUSD_TOKEN.decimals);
  const positive = parsed !== null && parsed > 0n;
  const over = parsed !== null && cap !== null && parsed > cap;
  const blocked = supply
    ? state === null || state.supplyPaused || !state.activated
    : state === null || !state.activated;
  const ready = address !== null && positive && !over && !blocked;
  const amountInvalid = amount.length > 0 && (parsed === null || !positive || over);
  const currentReviewIdentity = reviewKey([
    address,
    network.id,
    network.rpcUrl,
    mode,
    amount,
    parsed,
  ]);
  const reviewCurrent = reviewIdentity === currentReviewIdentity;

  const utilization = state === null || state.totalSupplied === 0n
    ? null
    : Number((state.totalBorrowed * 10_000n) / state.totalSupplied) / 100;

  const fillMax = (): void => {
    if (cap === null) return;
    setAmount(formatUnits(cap, NUSD_TOKEN.decimals));
  };

  useEffect(() => {
    setReviewOpen(false);
    setReviewIdentity(null);
  }, [address, amount, mode, network.id, network.rpcUrl]);

  useEffect(() => {
    if (!reviewOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) setReviewOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, reviewOpen]);

  const submit = (): void => {
    if (busy || !ready || !address || parsed === null) return;
    setError(null);
    setReviewIdentity(currentReviewIdentity);
    setReviewOpen(true);
  };

  const confirm = async (): Promise<void> => {
    if (
      busy
      || !reviewOpen
      || !reviewCurrent
      || !ready
      || !address
      || parsed === null
      || !confirmGate.tryEnter()
    ) return;
    const submitted = { from: address, amount: parsed, supply, network };
    setBusy(true);
    setError(null);
    try {
      const hash = submitted.supply
        ? await supplyNusd({ from: submitted.from, amount: submitted.amount })
        : await withdrawNusd({ from: submitted.from, amount: submitted.amount });
      notify(
        t(submitted.supply ? "lend.toastSupply" : "lend.toastWithdraw", {
          amount: formatAmount(submitted.amount, NUSD_TOKEN.decimals, 2),
          symbol: NUSD_TOKEN.symbol,
        }),
        "ok",
        txUrl(hash, submitted.network),
      );
      setAmount("");
      setReviewOpen(false);
      setReviewIdentity(null);
      refresh();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      confirmGate.leave();
      setBusy(false);
    }
  };
  return (
    <Screen title={t("lend.title")} onBack={goHome}>
      <div className="w-tabs" role="tablist" aria-label={t("common.direction")}>
        {(
          [
            ["supply", t("lend.supply")],
            ["withdraw", t("lend.withdraw")],
          ] as const
        ).map(([name, label]) => (
          <button
            key={name}
            type="button"
            role="tab"
            className="w-tab"
            aria-selected={mode === name}
            disabled={busy}
            onClick={() => {
              setMode(name);
              setAmount("");
              setError(null);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <form
        className="w-flow"
        aria-busy={busy || read.loading}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="w-flow-main">
          <AmountField
          label={supply ? t("lend.supplyLabel") : t("lend.withdrawLabel")}
          value={amount}
          invalid={amountInvalid}
          disabled={busy}
          onChange={(next) => {
            setAmount(next);
            setError(null);
          }}
          symbol={NUSD_TOKEN.symbol}
          onMax={cap === null ? undefined : fillMax}
          hint={
            cap === null
              ? t("send.readingBalance")
              : t(supply ? "lend.hintWallet" : "lend.hintWithdrawable", {
                amount: formatBalance(cap, NUSD_TOKEN.decimals),
                symbol: NUSD_TOKEN.symbol,
              })
          }
        />
        <Panel>
          <Rows>
            <Row
              label={t("lend.supplied")}
              value={state === null ? "…" : `${formatAmount(state.supplied, 18, 2)} NUSD`}
              tone="green"
            />
            {supply ? (
              <>
                <Row
                  label={t("lend.currentYield")}
                  value={state === null ? "…" : formatRateWad(state.supplyRateWad)}
                />
                <Row
                  label={t("lend.borrowApr")}
                  value={state === null ? "…" : formatRateWad(state.lenderRateWad)}
                />
                <Row
                  label={t("lend.utilization")}
                  value={utilization === null ? "…" : `${utilization.toFixed(2)}%`}
                />
              </>
            ) : (
              <>
                <Row
                  label={t("lend.maxWithdraw")}
                  value={state === null ? "…" : `${formatAmount(state.maxWithdraw, 18, 2)} NUSD`}
                />
                <Row
                  label={t("lend.liquidity")}
                  value={
                    state === null ? "…" : `${formatAmount(state.availableLiquidity, 18, 2)} NUSD`
                  }
                />
                <Row
                  label={t("lend.currentYield")}
                  value={state === null ? "…" : formatRateWad(state.supplyRateWad)}
                />
              </>
            )}
          </Rows>
        </Panel>
        {over ? (
          <Note tone="error">{supply ? t("lend.overWallet") : t("lend.overWithdraw")}</Note>
        ) : null}
        {state !== null && !state.activated ? (
          <Note tone="error">{t("lend.notActive")}</Note>
        ) : null}
        {supply && state?.supplyPaused === true && state.activated ? (
          <Note tone="error">{t("lend.supplyPaused")}</Note>
        ) : null}
          {read.error !== null ? <Note tone="error">{read.error}</Note> : null}
          <Note>{t("lend.note")}</Note>
        </div>
        <div className="w-flow-actions">
          {error !== null ? <Note tone="error">{error}</Note> : null}
          <Button type="submit" variant="primary" block disabled={busy || !ready}>
            {busy || read.loading
              ? t("common.working")
              : supply
              ? t("lend.submitSupply")
              : t("lend.submitWithdraw")}
          </Button>
        </div>
      </form>

      {reviewOpen && reviewCurrent && parsed !== null && address !== null ? (
        <div
          className="w-sheet"
          onClick={() => {
            if (!busy) setReviewOpen(false);
          }}
        >
          <div
            className="w-sheet-body w-swap-review"
            role="dialog"
            aria-modal="true"
            aria-labelledby="lend-review-title"
            aria-busy={busy}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="w-sheet-head">
              <span id="lend-review-title">{t("apr.titleTx")}</span>
              <button
                type="button"
                className="w-back"
                disabled={busy}
                aria-label={t("common.close")}
                onClick={() => setReviewOpen(false)}
              >
                ✕
              </button>
            </header>
            <div className="w-panel-body">
              <div className="w-summary">
                <span className="w-summary-label">
                  {supply ? t("lend.supply") : t("lend.withdraw")}
                </span>
                <span className="w-summary-value">
                  {formatAmount(parsed, NUSD_TOKEN.decimals, 6)} NUSD
                </span>
              </div>
              <Panel>
                <Rows>
                  <Row
                    label={t("lend.supplied")}
                    value={state === null ? "…" : `${formatAmount(state.supplied, 18, 2)} NUSD`}
                  />
                  {!supply ? (
                    <Row
                      label={t("lend.maxWithdraw")}
                      value={state === null
                        ? "…"
                        : `${formatAmount(state.maxWithdraw, 18, 2)} NUSD`}
                    />
                  ) : null}
                  <Row label={t("common.network")} value={network.name} />
                </Rows>
              </Panel>
              <Note tone="warn">{t("swap.reviewNotice")}</Note>
              {supply ? <Note>{t("swap.approvalHint")}</Note> : null}
              {error !== null ? <Note tone="error">{error}</Note> : null}
              <div className="w-btn-row">
                <Button disabled={busy} onClick={() => setReviewOpen(false)}>
                  {t("common.cancel")}
                </Button>
                <Button
                  variant="primary"
                  disabled={busy || !ready || !reviewCurrent}
                  onClick={() => void confirm()}
                >
                  {busy ? t("common.working") : t("swap.confirmSubmit")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </Screen>
  );
}
