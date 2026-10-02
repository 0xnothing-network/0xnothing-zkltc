import { useState } from "react";
import { formatUnits } from "viem";
import { isLitvmNetwork } from "../../../config/networks";
import { t } from "../../../core/i18n";
import { describeError } from "../../../core/lib/errors";
import { loadRwaState, quoteRwa, rwaMarkets, tradeRwa } from "../../../core/services/rwa";
import { Button, Empty, Note, Panel, PanelBody, Row, Rows } from "../../components/kit";
import { TransactionReview } from "../../components/TransactionReview";
import { useActionGate } from "../../hooks/useActionGate";
import { useLiveRead } from "../../hooks/useLiveRead";
import { useWallet } from "../../state/WalletContext";
import { parseRwaAmount, tradeLimit, type RwaMarketConfig } from "../../../../../../shared/rwa/core";

interface Review {
  amount: bigint; buy: boolean; limit: bigint; deadline: bigint; fee: bigint; total: bigint;
}

function RwaPosition({ config }: { config: RwaMarketConfig }) {
  const { address, network, tick, notify, refresh } = useWallet();
  const [buy, setBuy] = useState(true);
  const [text, setText] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gate = useActionGate();
  const amount = parseRwaAmount(text, config.assetDecimals);
  const state = useLiveRead(address ? () => loadRwaState(config, address) : null,
    [address, network.id, network.rpcUrl, config.market, tick],
    { identity: [address, network.id, network.rpcUrl, config.market] });
  const data = state.data;
  const quote = useLiveRead(amount && data && !data.paused && data.price && !state.error
    ? () => quoteRwa(config, buy, amount) : null,
    [config.market, network.id, network.rpcUrl, address, buy, amount, tick, Boolean(data && !data.paused && data.price && !state.error)],
    { debounceMs: 300 });
  const cash = (value: bigint) => `${formatUnits(value, config.settlementDecimals)} ${config.settlementSymbol}`;
  const limit = quote.data ? tradeLimit(quote.data.values[2], buy) : null;
  const enough = Boolean(data && amount && limit && (buy ? data.settlementBalance >= limit : data.assetBalance >= amount));
  const ready = Boolean(address && data && !state.error && !data.paused && data.price && amount && quote.data
    && !quote.error && !quote.busy && enough && !busy);

  async function confirm() {
    if (!review || !address || busy || state.error || !data || data.paused || !data.price || !gate.tryEnter()) return;
    setBusy(true); setError(null);
    try {
      await tradeRwa({ config, from: address, ...review });
      setReview(null); setText(""); refresh(); state.reload();
      notify(t("rwa.submitted"), "ok");
    } catch (cause) { setError(describeError(cause)); }
    finally { gate.leave(); setBusy(false); }
  }

  return <Panel title={config.name} aside={<span>{!data ? "…" : data.paused ? t("rwa.paused") : !data.price ? t("rwa.noPrice") : t("rwa.open")}</span>}>
    <PanelBody>
      <div className="w-stack">
        <Note>{t("rwa.issuer", { issuer: config.issuer })}</Note>
        {state.loading ? <Note>{t("rwa.loading")}</Note> : null}
        {state.error ? <Note tone="error">{state.error}</Note> : null}
        {data ? <Rows>
          <Row label={t("rwa.balance")} value={`${formatUnits(data.assetBalance, config.assetDecimals)} ${config.assetSymbol}`} />
          <Row label={t("rwa.liquidity")} value={cash(data.liquidity)} />
          <Row label={t("rwa.reserve")} value={cash(data.fees)} />
          <Row label={t("rwa.floor")} value={cash(data.reserveFloor)} />
          <Row label={t("rwa.daily")} value={cash(data.dailyRemaining)} />
          <Row label={t("rwa.price")} value={data.price ? `${formatUnits(data.price, 18)} ${config.settlementSymbol}` : "—"} />
        </Rows> : null}
        <div className="w-tabs" aria-label={t("rwa.direction")}>
          <button className="w-tab" aria-pressed={buy} type="button" disabled={busy || review !== null} onClick={() => setBuy(true)}>{t("rwa.buy")}</button>
          <button className="w-tab" aria-pressed={!buy} type="button" disabled={busy || review !== null} onClick={() => setBuy(false)}>{t("rwa.sell")}</button>
        </div>
        <label className="w-label">{t("rwa.amount", { symbol: config.assetSymbol })}
          <input className="w-input" inputMode="decimal" value={text} placeholder="0.00" disabled={busy || review !== null} onChange={(e) => setText(e.target.value)} />
        </label>
        {text && !amount ? <Note tone="error">{t("rwa.invalidAmount", { decimals: config.assetDecimals })}</Note> : null}
        {quote.error ? <Note tone="warn">{t("rwa.quoteUnavailable")}</Note> : null}
        {quote.data && !quote.error && amount ? <Rows>
          <Row label={t("rwa.fee")} value={cash(quote.data.values[1])} />
          <Row label={buy ? t("rwa.pay") : t("rwa.receive")} value={cash(quote.data.values[2])} />
        </Rows> : null}
        {quote.data && !enough ? <Note tone="warn">{t("rwa.insufficient")}</Note> : null}
        <Button block variant="primary" disabled={!ready} onClick={() => {
          if (!ready || !amount || !limit || !quote.data) return;
          setError(null);
          setReview({ amount, buy, limit, deadline: quote.data.deadline, fee: quote.data.values[1], total: quote.data.values[2] });
        }}>{t("rwa.review")}</Button>
        <a href={config.documentationUrl} target="_blank" rel="noreferrer">{t("rwa.documents")} ↗</a>
        <details><summary>{t("rwa.sources")}</summary>
          {config.sourceUrls.map((url, i) => <p key={`${i}:${url}`}><a href={url} target="_blank" rel="noreferrer">{t("rwa.source", { index: i + 1 })} ↗</a></p>)}
        </details>
        {error && !review ? <Note tone="error">{error}</Note> : null}
      </div>
    </PanelBody>
    {review ? <TransactionReview title={t("rwa.review")} busy={busy}
      ready={Boolean(!state.error && data && !data.paused && data.price)}
      onClose={() => { if (!busy) setReview(null); }} onConfirm={() => void confirm()}>
      <Rows>
        <Row label={review.buy ? t("rwa.buy") : t("rwa.sell")} value={`${formatUnits(review.amount, config.assetDecimals)} ${config.assetSymbol}`} />
        <Row label={t("rwa.fee")} value={cash(review.fee)} />
        <Row label={review.buy ? t("rwa.pay") : t("rwa.receive")} value={cash(review.total)} />
        <Row label={review.buy ? t("rwa.maxPayment") : t("rwa.minReceive")} value={cash(review.limit)} />
      </Rows>
      <Note>{t("rwa.slippage")}</Note>
      {error ? <Note tone="error">{error}</Note> : null}
    </TransactionReview> : null}
  </Panel>;
}

export function RwaList() {
  const { address, network } = useWallet();
  const markets = rwaMarkets.filter((market) => market.chainId === network.chainId);
  if (!isLitvmNetwork(network)) return <Note>{t("rwa.network")}</Note>;
  return <div className="w-stack">
    <Note>{t("rwa.policy")}</Note>
    {markets.length ? markets.map((config) => <RwaPosition key={`${config.market}:${address}:${network.id}:${network.rpcUrl}`} config={config} />)
      : <Empty><strong>{t("rwa.empty")}</strong><span>{t("rwa.activation")}</span></Empty>}
  </div>;
}
