import { type ReactNode, useEffect, useMemo, useState } from "react";
import { formatUnits, type Address } from "viem";
import {
  NATIVE_TOKEN,
  NUSD_TOKEN,
  type WalletToken,
} from "../../config/assets";
import { txUrl } from "../../config/chain";
import { t } from "../../core/i18n";
import { describeError } from "../../core/lib/errors";
import { formatAmount, formatBalance, parseAmount } from "../../core/lib/format";
import {
  applySlippage,
  NATIVE_GAS_RESERVE_WEI,
  spendableForSwap,
} from "../../core/lib/swapMath";
import { loadPortfolio } from "../../core/services/portfolio";
import {
  loadSwapCatalog,
  type SwapCatalogEntry,
} from "../../core/services/marketCatalog";
import { executeSwap, quoteSwap, routeLabel, type SwapRoute } from "../../core/services/swap";
import { addCustomToken } from "../../core/services/tokens";
import { AmountField } from "../components/AmountField";
import { Button, Note, Panel, Row, Rows } from "../components/kit";
import { Screen } from "../components/Screen";
import {
  SwapTokenPicker,
  type SwapTokenOption,
} from "../components/SwapTokenPicker";
import { TokenLogo } from "../components/TokenLogo";
import { useActionGate } from "../hooks/useActionGate";
import { useLiveRead } from "../hooks/useLiveRead";
import { reviewKey } from "../lib/reviewKey";
import { useWallet } from "../state/WalletContext";

function tokenOptions(
  walletTokens: readonly WalletToken[],
  catalogEntries: readonly SwapCatalogEntry[],
): SwapTokenOption[] {
  const options = new Map<string, SwapTokenOption>();
  for (const token of walletTokens) {
    options.set(token.id, { token, priority: token.builtin ? 0 : 3 });
  }
  for (const entry of catalogEntries) {
    const current = options.get(entry.token.id);
    if (current?.priority === 0) continue;
    const token = current
      ? { ...entry.token, ...current.token, logo: current.token.logo ?? entry.token.logo }
      : entry.token;
    options.set(token.id, { token, source: entry.source, priority: entry.priority });
  }
  return [...options.values()];
}

/**
 * SWAP. The route is chosen by `quoteSwap`; an active 0xPump curve is preferred
 * for non-graduated tokens, with the direct pool, NUSD bridge and oracle-spliced
 * shapes as fallbacks. The screen discloses what was chosen, especially when
 * the winner needs two confirmations instead of one.
 */
export function Swap(): ReactNode {
  const { address, tokens, settings, network, notify, refresh, tick, reload } = useWallet();
  const [inId, setInId] = useState(NUSD_TOKEN.id);
  const [outId, setOutId] = useState(NATIVE_TOKEN.id);
  const [amount, setAmount] = useState("");
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewRoute, setReviewRoute] = useState<SwapRoute | null>(null);
  const [reviewIdentity, setReviewIdentity] = useState<string | null>(null);
  const confirmGate = useActionGate();

  const tokenIn = tokens.find((entry) => entry.id === inId) ?? NATIVE_TOKEN;
  const tokenOut = tokens.find((entry) => entry.id === outId) ?? NUSD_TOKEN;
  const native = tokenIn.address === undefined;

  const catalog = useLiveRead(
    () => loadSwapCatalog(network),
    [network.id, network.rpcUrl],
    { live: false, identity: [network.id, network.rpcUrl] },
  );
  useEffect(() => {
    let timer: number | undefined;
    const clear = (): void => {
      if (timer === undefined) return;
      window.clearTimeout(timer);
      timer = undefined;
    };
    const schedule = (): void => {
      clear();
      if (document.hidden) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        catalog.reload();
        schedule();
      }, 30_000);
    };
    const onVisibility = (): void => {
      clear();
      if (document.hidden) return;
      catalog.reload();
      schedule();
    };
    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => {
      clear();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [catalog.reload, network.id]);
  const pickerOptions = useMemo(
    () => tokenOptions(tokens, catalog.data?.entries ?? []),
    [catalog.data?.entries, tokens],
  );

  const read = useLiveRead(
    address ? () => loadPortfolio(address, tokens) : null,
    [address, tokens, tick],
    { identity: [address, tokens] },
  );
  const balance = read.data?.rows.find((row) => row.token.id === tokenIn.id)?.balance ?? null;
  const parsed = parseAmount(amount, tokenIn.decimals);
  const positive = parsed !== null && parsed > 0n;
  const spendable = balance === null ? null : spendableForSwap(balance, native);
  const over = parsed !== null && spendable !== null && parsed > spendable;
  const reserveBlocked = native
    && parsed !== null
    && parsed > 0n
    && balance !== null
    && parsed <= balance
    && over;
  const same = tokenIn.id === tokenOut.id;

  const quote = useLiveRead(
    parsed !== null && positive && !over && !same
      ? () => quoteSwap({ tokenIn, tokenOut, amountIn: parsed })
      : null,
    [
      inId,
      outId,
      tokenIn.id,
      tokenIn.address ?? "native",
      tokenOut.id,
      tokenOut.address ?? "native",
      amount,
      positive && !over,
      network.id,
      network.rpcUrl,
    ],
    { debounceMs: 180 },
  );
  const route = quote.data;
  const label = route === null ? null : routeLabel(route, tokenIn.symbol, tokenOut.symbol);
  const minOut = route === null || route.amountOut === 0n
    ? null
    : applySlippage(route.amountOut, settings.slippageBps);
  const ready = address !== null
    && parsed !== null
    && positive
    && !over
    && route !== null
    && route.kind !== "none"
    && route.amountOut > 0n
    && !route.paused;
  const amountInvalid = amount.length > 0 && (parsed === null || !positive || over);
  const loading = read.loading || quote.loading;
  const currentReviewIdentity = reviewKey([
    address,
    network.id,
    network.rpcUrl,
    inId,
    tokenIn.address,
    outId,
    tokenOut.address,
    amount,
    parsed,
    settings.slippageBps,
  ]);
  const reviewCurrent = reviewIdentity === currentReviewIdentity;

  useEffect(() => {
    setReviewOpen(false);
    setReviewRoute(null);
    setReviewIdentity(null);
  }, [
    address,
    amount,
    inId,
    network.id,
    network.rpcUrl,
    outId,
    settings.slippageBps,
    tokenIn.address,
    tokenOut.address,
  ]);

  useEffect(() => {
    if (!reviewOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) setReviewOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, reviewOpen]);

  const flip = (): void => {
    setInId(tokenOut.id);
    setOutId(tokenIn.id);
    setAmount("");
    setError(null);
  };

  const fillMax = (): void => {
    if (balance === null) return;
    // A native max-in has to leave the gas reserve, or the swap cannot be sent.
    setAmount(formatUnits(spendableForSwap(balance, native), tokenIn.decimals));
  };

  const importFor = async (side: "in" | "out", candidate: Address): Promise<boolean> => {
    if (busy || tokenBusy) return false;
    setTokenBusy(true);
    setTokenError(null);
    try {
      const existing = tokens.find(
        (token) => token.address?.toLowerCase() === candidate.toLowerCase(),
      );
      let selected = existing;
      if (!selected) {
        const next = await addCustomToken(candidate, network);
        selected = next.find((token) => token.address?.toLowerCase() === candidate.toLowerCase());
        if (!selected) throw new Error(t("err.tokenUnreadable"));
        await reload();
      }
      if (side === "in") {
        setInId(selected.id);
        setAmount("");
      } else setOutId(selected.id);
      setReviewOpen(false);
      setError(null);
      return true;
    } catch (cause) {
      setTokenError(describeError(cause));
      return false;
    } finally {
      setTokenBusy(false);
    }
  };

  const choose = async (side: "in" | "out", option: SwapTokenOption): Promise<boolean> => {
    const existing = tokens.find((token) => token.id === option.token.id);
    if (!existing && option.token.address) return importFor(side, option.token.address);
    if (!existing) return false;
    if (side === "in") {
      setInId(existing.id);
      setAmount("");
    } else setOutId(existing.id);
    setReviewOpen(false);
    setTokenError(null);
    setError(null);
    return true;
  };

  const submit = (): void => {
    if (busy || tokenBusy || !ready || !address || parsed === null || route === null) return;
    setError(null);
    setReviewRoute(route);
    setReviewIdentity(currentReviewIdentity);
    setReviewOpen(true);
  };

  const confirmSwap = async (): Promise<void> => {
    if (
      busy
      || tokenBusy
      || !reviewOpen
      || !reviewCurrent
      || !ready
      || !address
      || parsed === null
      || reviewRoute === null
      || !confirmGate.tryEnter()
    ) return;
    const submitted = {
      from: address,
      tokenIn,
      tokenOut,
      amountIn: parsed,
      route: reviewRoute,
      slippageBps: settings.slippageBps,
      network,
    };
    setBusy(true);
    setError(null);
    try {
      const hash = await executeSwap({
        from: submitted.from,
        tokenIn: submitted.tokenIn,
        tokenOut: submitted.tokenOut,
        amountIn: submitted.amountIn,
        route: submitted.route,
        slippageBps: submitted.slippageBps,
      });
      notify(
        t("swap.toast", {
          amount: formatAmount(submitted.amountIn, submitted.tokenIn.decimals, 4),
          from: submitted.tokenIn.symbol,
          to: submitted.tokenOut.symbol,
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
      setReviewOpen(false);
    } finally {
      confirmGate.leave();
      setBusy(false);
    }
  };
  return (
    <Screen title={t("swap.title")}>
      <form
        className="w-flow w-swap-flow"
        aria-busy={busy || tokenBusy || loading}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="w-flow-main">
          <SwapTokenPicker
            label={t("swap.from")}
            options={pickerOptions}
            value={tokenIn}
            disabled={busy || tokenBusy}
            catalogLoading={catalog.loading}
            catalogUnavailable={catalog.error !== null || catalog.data?.degraded === true}
            onSelect={(option) => choose("in", option)}
            onImport={(candidate) => importFor("in", candidate)}
          />

          <div className="w-swap-flip">
            <Button
              size="sm"
              aria-label={t("swap.flip")}
              disabled={busy || tokenBusy}
              onClick={flip}
            >
              ↑↓
            </Button>
          </div>

          <SwapTokenPicker
            label={t("swap.to")}
            options={pickerOptions}
            value={tokenOut}
            disabled={busy || tokenBusy}
            catalogLoading={catalog.loading}
            catalogUnavailable={catalog.error !== null || catalog.data?.degraded === true}
            onSelect={(option) => choose("out", option)}
            onImport={(candidate) => importFor("out", candidate)}
          />

          {tokenError !== null ? <Note tone="error">{tokenError}</Note> : null}

          <AmountField
            label={t("swap.amountIn")}
            value={amount}
            invalid={amountInvalid}
            disabled={busy || tokenBusy}
            onChange={(next) => {
              setAmount(next);
              setError(null);
            }}
            symbol={tokenIn.symbol}
            onMax={balance === null ? undefined : fillMax}
            hint={
              balance === null
                ? t("send.readingBalance")
                : t("send.balanceHint", {
                  amount: formatBalance(balance, tokenIn.decimals),
                  symbol: tokenIn.symbol,
                })
            }
          />

          {route !== null ? (
            <>
              <div className="w-summary w-swap-summary">
                <span className="w-summary-label">{t("swap.receive")}</span>
                <span className="w-summary-value">
                  {route.amountOut === 0n
                    ? "--"
                    : `${formatAmount(route.amountOut, tokenOut.decimals, 6)} ${tokenOut.symbol}`}
                </span>
                <span className="w-summary-meta">
                  {t("swap.minReceive")}: {minOut === null
                    ? "--"
                    : `${formatAmount(minOut, tokenOut.decimals, 6)} ${tokenOut.symbol}`}
                </span>
              </div>
              <div className="w-swap-route">
                <span>{label ?? "--"}</span>
                <span>
                  {t("swap.poolFee")} {route.feeBps === null
                    ? "--"
                    : `${(route.feeBps / 100).toFixed(2)}%`}
                </span>
                <span>{t("swap.confirmations")} {route.stages}</span>
              </div>
            </>
          ) : null}

          {same ? <Note tone="warn">{t("swap.samePair")}</Note> : null}
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
          {route !== null && route.kind === "none" ? (
            <Note tone="warn">{t("swap.noRoute")}</Note>
          ) : null}
          {route?.paused === true ? <Note tone="error">{t("swap.routePaused")}</Note> : null}
          {route?.stages === 2 ? <Note tone="warn">{t("swap.twoStep")}</Note> : null}
          {native ? (
            <Note>
              {t("swap.gasReserve", {
                amount: formatAmount(NATIVE_GAS_RESERVE_WEI, NATIVE_TOKEN.decimals, 4),
                symbol: NATIVE_TOKEN.symbol,
              })}
            </Note>
          ) : null}
          {quote.error !== null ? <Note tone="warn">{quote.error}</Note> : null}
          {read.error !== null ? <Note tone="error">{read.error}</Note> : null}
        </div>

        <div className="w-flow-actions">
          {error !== null ? <Note tone="error">{error}</Note> : null}
          <Button type="submit" variant="primary" block disabled={busy || tokenBusy || !ready}>
            {loading ? t("common.working") : t("swap.submit")}
          </Button>
        </div>
      </form>

      {reviewOpen && reviewCurrent && reviewRoute !== null && parsed !== null && address !== null ? (
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
            aria-labelledby="swap-review-title"
            aria-busy={busy}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="w-sheet-head">
              <span id="swap-review-title">{t("swap.reviewTitle")}</span>
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

            <div className="w-swap-review-hero">
              <div>
                <TokenLogo token={tokenIn} size={34} />
                <strong>{formatAmount(parsed, tokenIn.decimals, 6)} {tokenIn.symbol}</strong>
              </div>
              <span className="w-review-arrow" aria-hidden="true">→</span>
              <div>
                <TokenLogo token={tokenOut} size={34} />
                <strong>
                  {formatAmount(reviewRoute.amountOut, tokenOut.decimals, 6)} {tokenOut.symbol}
                </strong>
              </div>
            </div>

            <div className="w-panel-body">
              <Panel>
                <Rows>
                  <Row
                    label={t("swap.minReceive")}
                    value={reviewRoute.amountOut === 0n
                      ? "--"
                      : `${formatAmount(
                          applySlippage(reviewRoute.amountOut, settings.slippageBps),
                          tokenOut.decimals,
                          6,
                        )} ${tokenOut.symbol}`}
                  />
                  <Row
                    label={t("swap.route")}
                    value={routeLabel(reviewRoute, tokenIn.symbol, tokenOut.symbol)}
                  />
                  <Row
                    label={t("swap.poolFee")}
                    value={reviewRoute.feeBps === null
                      ? "--"
                      : `${(reviewRoute.feeBps / 100).toFixed(2)}%`}
                  />
                  <Row
                    label={t("swap.maxSlippage")}
                    value={`${(settings.slippageBps / 100).toFixed(2)}%`}
                  />
                  <Row
                    label={t("swap.confirmations")}
                    value={reviewRoute.stages.toString()}
                  />
                  <Row label={t("common.network")} value={network.name} />
                </Rows>
              </Panel>
              <Note tone="warn">{t("swap.reviewNotice")}</Note>
              {!native ? <Note>{t("swap.approvalHint")}</Note> : null}
              {error !== null ? <Note tone="error">{error}</Note> : null}
              <div className="w-btn-row">
                <Button disabled={busy} onClick={() => setReviewOpen(false)}>
                  {t("common.cancel")}
                </Button>
                <Button
                  variant="primary"
                  disabled={busy || !ready || !reviewCurrent}
                  onClick={() => void confirmSwap()}
                >
                  {busy ? t("swap.swapping") : t("swap.confirmSubmit")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </Screen>
  );
}
