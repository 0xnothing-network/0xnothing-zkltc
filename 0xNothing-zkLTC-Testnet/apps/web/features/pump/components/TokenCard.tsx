import Link from "next/link";
import { formatDecimal, formatRelativeTime, formatWad } from "@/features/pump/format";
import type { PumpMarket } from "@/features/pump/types";
import { PumpTokenLogo } from "@/features/pump/components/PumpTokenLogo";

export function TokenCard({ market, priority = false }: { market: PumpMarket; priority?: boolean }) {
  return (
    <Link href={`/0xPump/token/${market.tokenAddress}`} className="pump-token-card">
      <div className="pump-token-card-head">
        <div className="pump-token-logo">
          <PumpTokenLogo
            imageUri={market.imageURI}
            name={market.name}
            symbol={market.symbol}
            size={56}
            sizes="(max-width: 640px) 52px, 56px"
            priority={priority}
          />
        </div>
        <span className={`pump-status pump-status-${market.status.toLowerCase()}`}>
          {market.status}
        </span>
      </div>

      <div className="pump-token-title-row">
        <div className="min-w-0">
          <h3>{market.name}</h3>
          <p>${market.symbol}</p>
        </div>
        <span className="pump-token-age">
          {market.tradeCount > 0 && market.lastTradeAt ? formatRelativeTime(market.lastTradeAt) : "No trades"}
        </span>
      </div>

      <dl className="pump-token-metrics">
        <div>
          <dt>Price</dt>
          <dd>${formatDecimal(market.priceNusd)}</dd>
        </div>
        <div>
          <dt>Market cap</dt>
          <dd>${formatWad(market.marketCapNusd)}</dd>
        </div>
        <div>
          <dt>Volume</dt>
          <dd>${formatWad(market.volumeNusd)}</dd>
        </div>
        <div>
          <dt>Trades</dt>
          <dd>{market.tradeCount}</dd>
        </div>
      </dl>

      <div className="pump-progress-label">
        <span>To $6,000 READY</span>
        <span>{(market.progressBps / 100).toFixed(1)}%</span>
      </div>
      <div className="pump-progress" role="progressbar" aria-label="Progress to READY" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, market.progressBps / 100)}>
        <span style={{ width: `${Math.min(100, market.progressBps / 100)}%` }} />
      </div>
    </Link>
  );
}
