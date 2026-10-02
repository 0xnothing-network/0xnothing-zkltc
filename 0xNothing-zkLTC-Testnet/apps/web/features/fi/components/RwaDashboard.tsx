"use client";

import { useRef, useState } from "react";
import { formatUnits } from "viem";
import { useAccount } from "wagmi";
import { deployment, explorerAddressUrl } from "@fi/config/deployment";
import { useProtocolTransaction } from "@fi/lib/hooks/useProtocolTransaction";
import { useRwaMarket } from "@fi/lib/hooks/useRwaMarket";
import { ConnectWalletButton } from "./ConnectWalletButton";
import { rwaMarkets } from "../../../../../shared/rwa/markets";
import { rwaMarketAbi } from "../../../../../shared/rwa/abi";
import { parseRwaAmount, tradeLimit, type RwaMarketConfig } from "../../../../../shared/rwa/core";
import "./rwa.css";

function RwaMarketPanel({ config, admin }: { config: RwaMarketConfig; admin: boolean }) {
  const { address, chainId } = useAccount();
  const [buy, setBuy] = useState(true);
  const [amountText, setAmountText] = useState("");
  const [reserveText, setReserveText] = useState("");
  const [notice, setNotice] = useState("");
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const amount = parseRwaAmount(amountText, config.assetDecimals);
  const reserveAmount = parseRwaAmount(reserveText, config.settlementDecimals);
  const { state, quote } = useRwaMarket(config, buy, amount);
  const tx = useProtocolTransaction();
  const data = state.data;
  const isOwner = Boolean(data && address && address.toLowerCase() === data.owner.toLowerCase());
  const correctChain = chainId === config.chainId;
  const cash = (value: bigint) => `${formatUnits(value, config.settlementDecimals)} ${config.settlementSymbol}`;
  const limit = quote.data ? tradeLimit(quote.data.values[2], buy) : null;
  const enough = Boolean(data && amount && limit && (buy ? data.settlementBalance >= limit : data.assetBalance >= amount));
  const ready = Boolean(address && correctChain && data && !state.isError && !data.paused && data.price
    && amount && quote.data && !quote.isError && !quote.isFetching && enough && !busy);

  async function trade() {
    if (!ready || !amount || !limit || !quote.data || lock.current) return;
    lock.current = true; setBusy(true); setNotice("");
    try {
      const hash = await tx.execute({
        approval: { token: buy ? config.settlement : config.asset, spender: config.market, amount: buy ? limit : amount },
        call: { address: config.market, abi: rwaMarketAbi, functionName: buy ? "buy" : "sell",
          args: [amount, limit, quote.data.deadline] },
      });
      if (hash) { setAmountText(""); setNotice("Trade confirmed."); }
      await state.refetch(); await quote.refetch();
    } finally { lock.current = false; setBusy(false); }
  }

  async function manage(action: "withdrawFees" | "reinvestFees" | "setPaused" | "fund") {
    if (!isOwner || !correctChain || !data || state.isError || lock.current || (action !== "setPaused" && !reserveAmount)) return;
    lock.current = true; setBusy(true); setNotice("");
    try {
      const hash = await tx.execute({
        ...(action === "fund" ? { approval: { token: config.settlement, spender: config.market, amount: reserveAmount! } } : {}),
        call: { address: config.market, abi: rwaMarketAbi, functionName: action,
          args: action === "withdrawFees" ? [address, reserveAmount] : action === "reinvestFees" ? [reserveAmount]
            : action === "fund" ? [false, reserveAmount] : [!data.paused] },
      });
      if (hash) { setReserveText(""); setNotice("Reserve operation confirmed."); }
      await state.refetch();
    } finally { lock.current = false; setBusy(false); }
  }

  return <section className="rwa-market" aria-label={config.name}>
    <header className="rwa-heading"><div><span className="rwa-eyebrow">{config.assetSymbol} / {config.settlementSymbol}</span><h2>{config.name}</h2></div>
      <span className="rwa-status">{state.isError ? "Read unavailable" : !data ? "Loading…" : data.paused ? "Paused" : !data.price ? "Price unavailable" : "Open"}</span></header>
    <p>Issuer: {config.issuer}. <a href={config.documentationUrl} target="_blank" rel="noreferrer">Asset documentation ↗</a></p>
    {state.isError ? <p role="alert">Market data unavailable. Trading is disabled. <button type="button" onClick={() => void state.refetch()}>Retry</button></p> : null}
    {data ? <>
      <dl className="rwa-metrics">
        <div><dt>Your RWA balance</dt><dd>{address ? `${formatUnits(data.assetBalance, config.assetDecimals)} ${config.assetSymbol}` : "Connect wallet"}</dd></div>
        <div><dt>Available sell liquidity</dt><dd>{cash(data.liquidity)}</dd></div>
        <div><dt>Fee reserve · 1% each trade</dt><dd>{cash(data.fees)}</dd></div>
        <div><dt>Protected reserve floor</dt><dd>{cash(data.reserveFloor)}</dd></div>
        <div><dt>Daily sell capacity left</dt><dd>{cash(data.dailyRemaining)}</dd></div>
        <div><dt>Maximum value per trade</dt><dd>{cash(data.maxTradeValue)}</dd></div>
      </dl>
      <p className="rwa-muted">Inventory: {formatUnits(data.inventory, config.assetDecimals)} {config.assetSymbol}. Price: {data.price ? `${formatUnits(data.price, 18)} ${config.settlementSymbol}` : "unavailable"}
        {data.priceUpdatedAt ? ` · updated ${new Date(Number(data.priceUpdatedAt) * 1000).toISOString()}` : " · trading stopped until all sources recover"}.</p>
    </> : null}
    {admin ? <div className="rwa-form">
      <p>Only the onchain owner can operate this reserve. Withdrawals go to the connected owner. Funding and reinvestment permanently commit funds to market liquidity.</p>
      <p>Withdrawable fees: {data ? cash(data.withdrawable) : "—"}. <a href={data ? explorerAddressUrl(data.owner) : explorerAddressUrl(config.market)} target="_blank" rel="noreferrer">View authority ↗</a></p>
      <label>Reserve amount ({config.settlementSymbol})<input inputMode="decimal" value={reserveText} disabled={busy} onChange={(e) => setReserveText(e.target.value)} placeholder="0.00" /></label>
      <div className="rwa-actions">
        <button disabled={!isOwner || !correctChain || state.isError || busy || !reserveAmount || !data || reserveAmount > data.withdrawable} onClick={() => void manage("withdrawFees")}>Withdraw fees</button>
        <button disabled={!isOwner || !correctChain || state.isError || busy || !reserveAmount || !data || reserveAmount > data.fees} onClick={() => void manage("reinvestFees")}>Reinvest fees permanently</button>
        <button disabled={!isOwner || !correctChain || state.isError || busy || !reserveAmount || !data || reserveAmount > data.settlementBalance} onClick={() => void manage("fund")}>Add permanent liquidity</button>
        <button disabled={!isOwner || !correctChain || state.isError || busy || !data} onClick={() => void manage("setPaused")}>{data?.paused ? "Open market" : "Pause trading"}</button>
      </div>
    </div> : <form className="rwa-form" onSubmit={(e) => { e.preventDefault(); void trade(); }}>
      <div className="rwa-actions" aria-label="Trade direction">
        <button type="button" aria-pressed={buy} disabled={busy} onClick={() => { setBuy(true); tx.reset(); }}>{`Buy ${config.assetSymbol}`}</button>
        <button type="button" aria-pressed={!buy} disabled={busy} onClick={() => { setBuy(false); tx.reset(); }}>{`Sell ${config.assetSymbol}`}</button>
      </div>
      <label>Asset amount ({config.assetSymbol})<input inputMode="decimal" value={amountText} disabled={busy} onChange={(e) => setAmountText(e.target.value)} placeholder="0.00" /></label>
      {amountText && !amount ? <p role="alert">Enter a positive amount with at most {config.assetDecimals} decimal places.</p> : null}
      {quote.data && !quote.isError && amount ? <dl className="rwa-metrics">
        <div><dt>Value before fee</dt><dd>{cash(quote.data.values[0])}</dd></div>
        <div><dt>Reserve fee · 1%</dt><dd>{cash(quote.data.values[1])}</dd></div>
        <div><dt>{buy ? "Total payment" : "You receive"}</dt><dd>{cash(quote.data.values[2])}</dd></div>
        <div><dt>{buy ? "Maximum payment · 0.5% slippage" : "Minimum received · 0.5% slippage"}</dt><dd>{limit ? cash(limit) : "—"}</dd></div>
      </dl> : null}
      {quote.isError ? <p role="alert">No executable quote. Check price availability, inventory, trade limits and sell liquidity.</p> : null}
      {address && quote.data && !enough ? <p role="alert">Insufficient balance for this trade and its maximum payment.</p> : null}
      {!address ? <ConnectWalletButton /> : <button className="rwa-submit" disabled={!ready}>{busy ? "Confirming…" : buy ? "Buy · fee 1%" : "Sell · fee 1%"}</button>}
    </form>}
    {address && !correctChain ? <p role="alert">Switch your wallet to LitVM LiteForge (chain {config.chainId}).</p> : null}
    <p role="status">{notice || tx.message}</p>
    {tx.hash ? <a href={`${deployment.chain.explorerUrl}/tx/${tx.hash}`} target="_blank" rel="noreferrer">View transaction ↗</a> : null}
    <details><summary>Contracts and price sources</summary><a href={explorerAddressUrl(config.market)} target="_blank" rel="noreferrer">Market: {config.market}</a>
      <ol>{config.sourceUrls.map((url, i) => <li key={`${i}:${url}`}><a href={url} target="_blank" rel="noreferrer">{i < 2 ? "Asset / USD" : "Settlement / USD"} source {i % 2 + 1} ↗</a></li>)}</ol>
    </details>
  </section>;
}

export function RwaDashboard({ admin = false }: { admin?: boolean }) {
  const markets = rwaMarkets.filter((market) => market.chainId === deployment.chain.id);
  return <div className="rwa-dashboard">
    <p className="rwa-policy">Onchain trading is available around the clock while prices are valid and liquidity is available. Each buy and sell charges 1% into the fee reserve. Dev withdrawals cannot remove trading liquidity or the protected reserve floor.</p>
    {markets.length === 0 ? <section className="rwa-market"><h2>No RWA market activated</h2><p>Trading opens after an issuer token, independent price sources and funded reserves are verified on this network.</p></section>
      : markets.map((config) => <RwaMarketPanel key={config.market} config={config} admin={admin} />)}
  </div>;
}
