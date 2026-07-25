"use client";

import Link from "next/link";
import Image from "next/image";
import { parseUnits } from "viem";
import { usePumpPortfolio } from "@/features/pump/hooks/usePumpData";
import { formatRelativeTime, formatTokenAmount, formatWad } from "@/features/pump/format";
import { ipfsToGatewayUrl } from "@/features/pump/config";
import type { PumpMarket } from "@/features/pump/types";
import { PumpConfigNotice, PumpErrorState, PumpLoadingRows } from "@/features/pump/components/PumpStates";

export function PumpPortfolio() {
  const portfolio = usePumpPortfolio();
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
              <PumpErrorState message={portfolio.heldError.message} onRetry={portfolio.refetchHeld} />
            ) : portfolio.heldIsLoading ? (
              <PumpLoadingRows count={3} />
            ) : portfolio.held.length ? (
              <div className="pump-portfolio-list">{portfolio.held.map((market) => (
                <PortfolioRow
                  key={market.tokenAddress}
                  market={market}
                  valueLabel="Balance"
                  value={`${formatTokenAmount(portfolio.balances.get(market.tokenAddress.toLowerCase()) ?? 0n)} ${market.symbol}`}
                  currentValue={calculateCurrentValue(
                    portfolio.balances.get(market.tokenAddress.toLowerCase()) ?? 0n,
                    market.priceNusd,
                  )}
                />
              ))}</div>
            ) : <div className="pump-empty-inline"><p>No 0xPump token balances found.</p><Link href="/0xpump">Browse markets</Link></div>}
          </section>

          <section className="pump-portfolio-section">
            <div className="pump-section-heading"><div><span className="pump-eyebrow">Creator</span><h2>Markets created</h2></div><span>{portfolio.created.length}</span></div>
            {portfolio.createdError ? (
              <PumpErrorState message={portfolio.createdError.message} onRetry={portfolio.refetchCreated} />
            ) : portfolio.createdIsLoading ? (
              <PumpLoadingRows count={2} />
            ) : portfolio.created.length ? (
              <div className="pump-portfolio-list">{portfolio.created.map((market) => (
                <PortfolioRow
                  key={market.tokenAddress}
                  market={market}
                  valueLabel="Market cap"
                  value={`$${formatWad(market.marketCapNusd)}`}
                />
              ))}</div>
            ) : <div className="pump-empty-inline"><p>This wallet has not launched a market.</p><Link href="/0xpump/create">Create token</Link></div>}
          </section>
        </>
      )}
    </main>
  );
}

function PortfolioRow({
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
  const image = ipfsToGatewayUrl(market.imageURI);
  const optimizeImage = market.imageURI.startsWith("ipfs://");
  return (
    <Link href={`/0xpump/token/${market.tokenAddress}`} className="pump-portfolio-row">
      <span className="pump-portfolio-logo">
        {image && optimizeImage ? (
          <Image src={image} alt="" width={42} height={42} sizes="42px" />
        ) : image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="" loading="lazy" decoding="async" />
        ) : <span>{market.symbol.slice(0, 2)}</span>}
      </span>
      <span className="pump-portfolio-identity">
        <strong>{market.name}</strong>
        <small>${market.symbol} / {market.tradeCount > 0 ? formatRelativeTime(market.lastTradeAt) : "No trades"}</small>
      </span>
      <span className="pump-portfolio-value">
        <small>{valueLabel}</small>
        <strong>{value}</strong>
        {currentValue !== undefined ? (
          <span className="pump-portfolio-current-value">${formatWad(currentValue)}</span>
        ) : null}
      </span>
      <span className={`pump-status pump-status-${market.status.toLowerCase()}`}>{market.status}</span>
      <span className="pump-portfolio-arrow" aria-hidden="true">&rarr;</span>
    </Link>
  );
}

function calculateCurrentValue(balance: bigint, priceNusd: string) {
  try {
    return balance * parseUnits(priceNusd, 18) / 10n ** 18n;
  } catch {
    return 0n;
  }
}
