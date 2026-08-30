import type { ReactNode } from "react";
import { t } from "../../../core/i18n";
import { formatBalance, formatUsdWad } from "../../../core/lib/format";
import type { AssetRow } from "../../../core/services/portfolio";
import { visibleRows } from "../../../core/services/portfolio";
import { Empty, Note } from "../../components/kit";
import { TokenLogo } from "../../components/TokenLogo";
import { VerifiedMark } from "../../components/VerifiedMark";

/**
 * The TOKEN tab. A row opens the send screen already pointed at that token — it
 * is the only thing a wallet list is ever tapped for.
 *
 * A "~" in front of a USD figure means the oracle round behind it is stale; the
 * balance is still exact, only the conversion is old, and saying so is better
 * than showing a confident number.
 */
export function AssetList({
  rows,
  loading = false,
  failed = false,
}: {
  rows: readonly AssetRow[];
  loading?: boolean;
  /** The parent already renders the read error beside the portfolio total. */
  failed?: boolean;
}): ReactNode {
  const listed = visibleRows(rows);
  if (listed.length === 0) {
    if (failed) return null;
    return (
      <div aria-busy={loading} aria-live="polite">
        <Empty>{loading ? t("asset.loading") : t("asset.empty")}</Empty>
      </div>
    );
  }
  const anyStale = listed.some((row) => row.stale && row.priceWad > 0n);

  return (
    <>
      <div className="w-list" aria-busy={loading}>
        {listed.map((row) => (
          <a
            key={row.token.id}
            className="w-asset"
            href={`#/send?token=${encodeURIComponent(row.token.id)}`}
          >
            <TokenLogo token={row.token} />
            <span className="w-asset-main">
              <span className="w-asset-symbol w-token-symbol">
                {row.token.symbol}
                <VerifiedMark verified={row.token.verified} />
              </span>
              <span className="w-asset-sub">{row.token.name}</span>
            </span>
            <span className="w-asset-side">
              <span className="w-asset-amount">
                {formatBalance(row.balance, row.token.decimals)}
              </span>
              <span className="w-asset-usd">
                {row.priceWad === 0n
                  ? "--"
                  : `${row.stale ? "~" : ""}${formatUsdWad(row.valueWad)}`}
              </span>
            </span>
          </a>
        ))}
      </div>
      {anyStale ? (
        <div className="w-stack">
          <Note tone="warn">{t("asset.staleNote")}</Note>
        </div>
      ) : null}
    </>
  );
}
