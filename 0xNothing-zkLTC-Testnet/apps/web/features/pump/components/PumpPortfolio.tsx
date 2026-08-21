"use client";

import { memo, useMemo } from "react";
import Link from "next/link";
import { parseUnits } from "viem";
import { usePumpPortfolio } from "@/features/pump/hooks/usePumpData";
import { formatRelativeTime, formatTokenAmount, formatWad } from "@/features/pump/format";
import type { PumpMarket } from "@/features/pump/types";
import { PumpConfigNotice, PumpErrorState, PumpLoadingRows } from "@/features/pump/components/PumpStates";
import { PumpTokenLogo } from "@/features/pump/components/PumpTokenLogo";

const PortfolioRowInner = memo(function PortfolioRowInner({
  market,
  valueLabel,
  value,
  currentValue,
}: {
  market: PumpMarket;
  valueLabel: string;
  value: string;
  currentValue?: bigint;
}) {
  const tradeAge = useMemo(
    () => market.tradeCount > 0 ? formatRelativeTime(market.lastTradeAt) : "No trades",
    [market.lastTradeAt, market.tradeCount],
  );
  const currentValueLabel = useMemo(
    () => currentValue !== undefined ? formatWad(currentValue) : "",
    [currentValue],
  );
  return (
    <Link href={`/0xPump/token/${market.tokenAddress}`} className="pump-portfolio-row">
      <span className="pump-portfolio-logo">
        <PumpTokenLogo
          imageUri={market.imageURI}
          name={market.name}
          symbol={market.symbol}
          size={42}
          decorative
        />
      </span>
      <span className="pump-portfolio-identity">
        <strong>{market.name}</strong>
        <small>${market.symbol} / {tradeAge}</small>
      </span>
      <span className="pump-portfolio-value">
        <small>{valueLabel}</small>
        <strong>{value}</strong>
        {currentValue !== undefined ? (
          <span className="pump-portfolio-current-value">${currentValueLabel}</span>
        ) : null}
      </span>
      <span className={`pump-status pump-status-${market.status.toLowerCase()}`}>{market.status}</span>
      <span className="pump-portfolio-arrow" aria-hidden="true">&rarr;</span>
    </Link>
  );
});

function calculateCurrentValue(balance: bigint, priceNusd: string) {
  try {
    return balance * parseUnits(priceNusd, 18) / 10n ** 18n;
  } catch {
    return 0n;
  }
}

export function PumpPortfolio() {
  const portfolio = usePumpPortfolio();
  const handleRefetchHeld = portfolio.refetchHeld;
  const handleRefetchCreated = portfolio.refetchCreated;

  const heldRows = useMemo(() => {
    if (!portfolio.held.length) return null;
    return portfolio.held.map((market) => {
      const bal = portfolio.balances.get(market.tokenAddress.toLowerCase()) ?? 0n;
      return (
        <PortfolioRowInner
          key={market.tokenAddress}
          market={market}
          valueLabel="Balance"
          value={`${formatTokenAmount(bal)} ${market.symbol}`}
          currentValue={calculateCurrentValue(bal, market.priceNusd)}
        />
      );
    });
  }, [portfolio.balances, portfolio.held]);

  const createdRows = useMemo(() => {
    if (!portfolio.created.length) return null;
    return portfolio.created.map((market) => (
      <PortfolioRowInner
        key={market.tokenAddress}
        market={market}
        valueLabel="Market cap"
        value={`$${formatWad(market.marketCapNusd)}`}
      />
    ));
  }, [portfolio.created]);

  return (
    <main className="pump-page pump-portfolio-page">
      <section className="pump-page-heading pump-portfolio-heading">
        <div><h1>Portfolio</h1><span>Wallet inventory</span></div>
      </section>

      {!portfolio.configured ? <PumpConfigNotice /> : null}
      {!portfolio.address ? (
        <div className="pump-empty-state"><span className="pump-eyebrow">Wallet required</span><h2>Connect to view your portfolio</h2><p>Use the connect control above to load created and held tokens.</p></div>
      ) : (
        <>
          <section className="pump-portfolio-section">
            <div className="pump-section-heading"><div><span className="pump-eyebrow">Balances</span><h2>Tokens held</h2></div><span>{portfolio.held.length}</span></div>
            {portfolio.balanceWarning ? <p className="pump-source-note">{portfolio.balanceWarning}</p> : null}
            {portfolio.heldError ? (
              <PumpErrorState message={(portfolio.heldError as Error).message} onRetry={handleRefetchHeld} />
            ) : portfolio.heldIsLoading ? (
              <PumpLoadingRows count={3} />
            ) : portfolio.held.length ? (
              <div className="pump-portfolio-list">{heldRows}</div>
            ) : <div className="pump-empty-inline"><p>No 0xPump token balances found.</p><Link href="/0xPump">Browse markets</Link></div>}
          </section>

          <section className="pump-portfolio-section">
            <div className="pump-section-heading"><div><span className="pump-eyebrow">Creator</span><h2>Markets created</h2></div><span>{portfolio.created.length}</span></div>
            {portfolio.createdError ? (
              <PumpErrorState message={(portfolio.createdError as Error).message} onRetry={handleRefetchCreated} />
            ) : portfolio.createdIsLoading ? (
              <PumpLoadingRows count={2} />
            ) : portfolio.created.length ? (
              <div className="pump-portfolio-list">{createdRows}</div>
            ) : <div className="pump-empty-inline"><p>This wallet has not launched a market.</p><Link href="/0xPump/create">Create token</Link></div>}
          </section>
        </>
      )}
    </main>
  );
}
