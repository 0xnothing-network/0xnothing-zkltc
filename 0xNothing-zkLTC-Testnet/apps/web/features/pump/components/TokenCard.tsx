import Link from "next/link";
import { memo, useMemo } from "react";
import { formatDecimal, formatRelativeTime, formatWad } from "@/features/pump/format";
import type { PumpMarket } from "@/features/pump/types";
import { PumpTokenLogo } from "@/features/pump/components/PumpTokenLogo";

const progressStyleCache = new Map<number, { width: string }>();
function getProgressStyle(progressBps: number) {
  const pct = Math.min(100, progressBps / 100);
  const key = Math.round(pct * 10);
  let style = progressStyleCache.get(key);
  if (!style) {
    style = { width: `${(key / 10).toFixed(1).replace(/\.0$/, "")}%` };
    if (progressStyleCache.size > 128) {
      const oldest = progressStyleCache.keys().next().value as number | undefined;
      if (oldest !== undefined) progressStyleCache.delete(oldest);
    }
    progressStyleCache.set(key, style);
  }
  return style;
}

function TokenCardInner({ market, priority = false }: { market: PumpMarket; priority?: boolean }) {
  const progressStyle = useMemo(() => getProgressStyle(market.progressBps), [market.progressBps]);
  const progressLabel = useMemo(() => `${(market.progressBps / 100).toFixed(1)}%`, [market.progressBps]);
  const progressAria = useMemo(() => Math.min(100, market.progressBps / 100), [market.progressBps]);
  const priceLabel = useMemo(() => formatDecimal(market.priceNusd), [market.priceNusd]);
  const capLabel = useMemo(() => formatWad(market.marketCapNusd), [market.marketCapNusd]);
  const volumeLabel = useMemo(() => formatWad(market.volumeNusd), [market.volumeNusd]);
  const tradeAge = useMemo(
    () => market.tradeCount > 0 && market.lastTradeAt ? formatRelativeTime(market.lastTradeAt) : "No trades",
    [market.lastTradeAt, market.tradeCount],
  );

  return (
    <Link href={`/0xPump/token/${market.tokenAddress}`} className="pump-token-card">
      <div className="pump-token-card-head">
        <div className="pump-token-logo">
          <PumpTokenLogo
            imageUri={market.imageURI}
            name={market.name}
            symbol={market.symbol}
            size={56}
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
        <span className="pump-token-age">{tradeAge}</span>
      </div>

      <dl className="pump-token-metrics">
        <div>
          <dt>Price</dt>
          <dd>${priceLabel}</dd>
        </div>
        <div>
          <dt>Market cap</dt>
          <dd>${capLabel}</dd>
        </div>
        <div>
          <dt>Volume</dt>
          <dd>${volumeLabel}</dd>
        </div>
        <div>
          <dt>Trades</dt>
          <dd>{market.tradeCount}</dd>
        </div>
      </dl>

      <div className="pump-progress-label">
        <span>To $6,000 READY</span>
        <span>{progressLabel}</span>
      </div>
      <div className="pump-progress" role="progressbar" aria-label="Progress to READY" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressAria}>
        <span style={progressStyle} />
      </div>
    </Link>
  );
}

export const TokenCard = memo(TokenCardInner, (prev, next) =>
  prev.priority === next.priority &&
  prev.market.tokenAddress === next.market.tokenAddress &&
  prev.market.name === next.market.name &&
  prev.market.symbol === next.market.symbol &&
  prev.market.imageURI === next.market.imageURI &&
  prev.market.status === next.market.status &&
  prev.market.priceNusd === next.market.priceNusd &&
  prev.market.marketCapNusd === next.market.marketCapNusd &&
  prev.market.volumeNusd === next.market.volumeNusd &&
  prev.market.progressBps === next.market.progressBps &&
  prev.market.tradeCount === next.market.tradeCount &&
  prev.market.lastTradeAt === next.market.lastTradeAt,
);
