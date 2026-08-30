import { type ReactNode, useEffect, useState } from "react";
import { formatUnits } from "viem";
import { NATIVE_TOKEN, NUSD_TOKEN } from "../../config/assets";
import { txUrl } from "../../config/chain";
import { t } from "../../core/i18n";
import { describeError } from "../../core/lib/errors";
import { formatAmount, formatBalance, formatUsdWad, parseAmount } from "../../core/lib/format";
import {
  applySlippage,
  NATIVE_GAS_RESERVE_WEI,
  spendableForSwap,
} from "../../core/lib/swapMath";
import {
  loadOracleState,
  mintNusd,
  quoteMint,
  quoteRedeem,
  redeemNusd,
} from "../../core/services/oracle";
import { loadPortfolio } from "../../core/services/portfolio";
import { AmountField } from "../components/AmountField";
import { Button, Note, Panel, Row, Rows } from "../components/kit";
import { Screen } from "../components/Screen";
import { TokenLogo } from "../components/TokenLogo";
import { TransactionReview } from "../components/TransactionReview";
import { useActionGate } from "../hooks/useActionGate";
import { useLiveRead } from "../hooks/useLiveRead";
import { reviewKey } from "../lib/reviewKey";
import { goHome } from "../router";
import { useWallet } from "../state/WalletContext";

/**
 * MINT NUSD, and its mirror image on the same screen. zkLTC in at the DIA feed
 * price with no AMM fee, NUSD out; the redeem tab walks the same path backwards.
 *
 * Every guard here fails closed: a pause flag that could not be read counts as
 * paused, and a price the adapter no longer calls fresh disarms the button —
 * the contract would revert anyway, and it is cheaper to say so first.
 */
type Mode = "mint" | "redeem";

export function MintNusd(): ReactNode {
  const { address, tokens, settings, network, notify, refresh, tick } = useWallet();
  const [mode, setMode] = useState<Mode>("mint");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewQuote, setReviewQuote] = useState<bigint | null>(null);
  const [reviewIdentity, setReviewIdentity] = useState<string | null>(null);
  const confirmGate = useActionGate();

  // Oracle panel and balances are requested together, so the client-level
  // multicall collapses them into one round trip instead of two.
  const read = useLiveRead(
    address && network.builtin
      ? async () => {
          const [state, portfolio] = await Promise.all([
            loadOracleState(),
            loadPortfolio(address, tokens),
          ]);
          return { state, portfolio };
        }
      : null,
    [address, network.id, network.rpcUrl, tokens, tick],
    { identity: [address, network.id, network.rpcUrl, tokens] },
  );
  const state = read.data?.state ?? null;
  const rows = read.data?.portfolio.rows ?? [];
  const mint = mode === "mint";
  const inputToken = mint ? NATIVE_TOKEN : NUSD_TOKEN;
  const outputToken = mint ? NUSD_TOKEN : NATIVE_TOKEN;
  const balance = rows.find((row) => row.token.id === inputToken.id)?.balance ?? null;

  const parsed = parseAmount(amount, inputToken.decimals);
  const positive = parsed !== null && parsed > 0n;
  const spendable = balance === null ? null : spendableForSwap(balance, mint);
  const over = parsed !== null && spendable !== null && parsed > spendable;
  const reserveBlocked = mint
    && parsed !== null
    && parsed > 0n
    && balance !== null
    && parsed <= balance
    && over;

  const quote = useLiveRead(
    parsed !== null && positive && !over ? () => (mint ? quoteMint(parsed) : quoteRedeem(parsed)) : null,
    [mode, amount, positive && !over, network.id, network.rpcUrl],
    { debounceMs: 180 },
  );
  const quoted = quote.data;
  const minOut = quoted === null ? null : applySlippage(quoted, settings.slippageBps);

  // Fail closed while the flags are unknown: `state === null` reads as paused.
  const paused = mint ? state?.mintPaused !== false : state?.redeemPaused !== false;
  const fresh = state?.priceFresh === true;
  const overHeadroom = mint && quoted !== null && state !== null && quoted > state.headroomNusd;
  const overCollateral = !mint && quoted !== null && state !== null && quoted > state.collateralWei;
  const ready = address !== null
    && parsed !== null
    && positive
    && !over
    && quoted !== null
    && quoted > 0n
    && !paused
    && fresh
    && !overHeadroom
    && !overCollateral;
  const amountInvalid = amount.length > 0 && (parsed === null || !positive || over);
  const loading = read.loading || quote.loading;
  const currentReviewIdentity = reviewKey([
    address,
    network.id,
    network.rpcUrl,
    mode,
    amount,
    parsed,
    settings.slippageBps,
  ]);
  const reviewCurrent = reviewIdentity === currentReviewIdentity;

  useEffect(() => {
    setReviewOpen(false);
    setReviewQuote(null);
    setReviewIdentity(null);
  }, [address, amount, mode, network.id, network.rpcUrl, settings.slippageBps]);

  const fillMax = (): void => {
    if (balance === null) return;
    // The gas coin keeps its reserve; NUSD can go out to the last wei.
    setAmount(formatUnits(spendableForSwap(balance, mint), inputToken.decimals));
  };
  const submit = (): void => {
    if (busy || !ready || !address || parsed === null || quoted === null) return;
    setError(null);
    setReviewQuote(quoted);
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
      || reviewQuote === null
      || !confirmGate.tryEnter()
    ) {
      return;
    }
    const submitted = {
      from: address,
      amount: parsed,
      quote: reviewQuote,
      mint,
      slippageBps: settings.slippageBps,
      network,
    };
    setBusy(true);
    setError(null);
    try {
      const hash = submitted.mint
        ? await mintNusd({
            from: submitted.from,
            collateralWei: submitted.amount,
            quotedNusd: submitted.quote,
            slippageBps: submitted.slippageBps,
          })
        : await redeemNusd({
            from: submitted.from,
            amountNusd: submitted.amount,
            quotedCollateralWei: submitted.quote,
            slippageBps: submitted.slippageBps,
          });
      notify(
        t(submitted.mint ? "mint.toastMint" : "mint.toastRedeem", {
          amount: formatAmount(
            submitted.mint ? submitted.quote : submitted.amount,
            NUSD_TOKEN.decimals,
            2,
          ),
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
  if (!network.builtin) {
    return (
      <Screen title={t("mint.title")} onBack={goHome}>
        <div className="w-stack">
          <Note tone="warn">{t("network.protocolOnly", { network: "LitVM LiteForge" })}</Note>
        </div>
      </Screen>
    );
  }

  return (
    <Screen title={t("mint.title")} onBack={goHome}>
      <div className="w-tabs" role="tablist" aria-label={t("common.direction")}>
        {(
          [
            ["mint", t("mint.title")],
            ["redeem", t("mint.redeem", { symbol: NATIVE_TOKEN.symbol })],
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
        aria-busy={busy || loading}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="w-flow-main">
          <AmountField
          label={t(mint ? "mint.payWith" : "mint.redeemFrom", { symbol: inputToken.symbol })}
          value={amount}
          invalid={amountInvalid}
          disabled={busy}
          onChange={(next) => {
            setAmount(next);
            setError(null);
          }}
          symbol={inputToken.symbol}
          onMax={balance === null ? undefined : fillMax}
          hint={
            balance === null
              ? t("send.readingBalance")
              : t("send.balanceHint", {
                amount: formatBalance(balance, inputToken.decimals),
                symbol: inputToken.symbol,
              })
          }
        />
          <div className="w-summary">
            <span className="w-summary-label">{t("swap.receive")}</span>
            <span className="w-summary-value">
              {quoted === null
                ? "--"
                : `${formatAmount(quoted, outputToken.decimals, mint ? 2 : 6)} ${outputToken.symbol}`}
            </span>
            <span className="w-summary-meta">
              {t("swap.minReceive")}: {minOut === null
                ? "--"
                : `${formatAmount(minOut, outputToken.decimals, mint ? 2 : 6)} ${outputToken.symbol}`}
            </span>
          </div>
          <Panel>
            <Rows>
              <Row
                label={t("mint.price", { symbol: NATIVE_TOKEN.symbol })}
                value={
                  state === null ? "…" : `${fresh ? "" : "~"}${formatUsdWad(state.priceWad)}`
                }
                tone={state !== null && !fresh ? "dim" : undefined}
              />
              <Row
                label={t("swap.maxSlippage")}
                value={`${(settings.slippageBps / 100).toFixed(2)}%`}
              />
              {mint ? (
                <Row
                  label={t("mint.headroom")}
                  value={
                    state === null
                      ? "…"
                      : t("common.amountWithSymbol", {
                        amount: formatAmount(state.headroomNusd, NUSD_TOKEN.decimals, 2),
                        symbol: NUSD_TOKEN.symbol,
                      })
                  }
                />
              ) : (
                <Row
                  label={t("mint.collateral")}
                  value={
                    state === null
                      ? "…"
                      : t("common.amountWithSymbol", {
                        amount: formatAmount(state.collateralWei, NATIVE_TOKEN.decimals, 4),
                        symbol: NATIVE_TOKEN.symbol,
                      })
                  }
                />
              )}
            </Rows>
          </Panel>
        {over ? (
          <Note tone="error">
            {reserveBlocked
              ? t("send.gasShort", {
                  amount: formatAmount(NATIVE_GAS_RESERVE_WEI, NATIVE_TOKEN.decimals),
                  symbol: NATIVE_TOKEN.symbol,
                })
              : t("send.overBalance")}
          </Note>
        ) : null}
        {state !== null && paused ? (
          <Note tone="error">{t(mint ? "mint.pausedMint" : "mint.pausedRedeem")}</Note>
        ) : null}
        {state !== null && !fresh ? <Note tone="warn">{t("mint.stalePrice")}</Note> : null}
        {overHeadroom ? <Note tone="error">{t("mint.overHeadroom")}</Note> : null}
        {overCollateral ? (
          <Note tone="error">{t("mint.overCollateral", { symbol: NATIVE_TOKEN.symbol })}</Note>
        ) : null}
        {quote.error !== null ? <Note tone="warn">{quote.error}</Note> : null}
          {read.error !== null ? <Note tone="error">{read.error}</Note> : null}
          <Note>{t("mint.note")}</Note>
        </div>
        <div className="w-flow-actions">
          {error !== null ? <Note tone="error">{error}</Note> : null}
          <Button type="submit" variant="primary" block disabled={busy || !ready}>
            {busy || loading
              ? t("common.working")
              : mint
              ? t("mint.title")
              : t("mint.redeem", { symbol: NATIVE_TOKEN.symbol })}
          </Button>
        </div>
      </form>
      {reviewOpen && reviewCurrent && reviewQuote !== null && parsed !== null && address !== null ? (
        <TransactionReview
          title={t("apr.titleTx")}
          busy={busy}
          ready={ready && reviewCurrent}
          onClose={() => setReviewOpen(false)}
          onConfirm={() => void confirm()}
          hero={(
            <div className="w-swap-review-hero">
              <div>
                <TokenLogo token={inputToken} size={34} />
                <strong>{formatAmount(parsed, inputToken.decimals, 6)} {inputToken.symbol}</strong>
              </div>
              <span className="w-review-arrow" aria-hidden="true">→</span>
              <div>
                <TokenLogo token={outputToken} size={34} />
                <strong>
                  {formatAmount(reviewQuote, outputToken.decimals, mint ? 2 : 6)} {outputToken.symbol}
                </strong>
              </div>
            </div>
          )}
        >
          <Panel>
            <Rows>
              <Row
                label={t("swap.minReceive")}
                value={`${formatAmount(
                  applySlippage(reviewQuote, settings.slippageBps),
                  outputToken.decimals,
                  mint ? 2 : 6,
                )} ${outputToken.symbol}`}
              />
              <Row
                label={t("swap.maxSlippage")}
                value={`${(settings.slippageBps / 100).toFixed(2)}%`}
              />
              <Row label={t("common.network")} value={network.name} />
            </Rows>
          </Panel>
        </TransactionReview>
      ) : null}
    </Screen>
  );
}
