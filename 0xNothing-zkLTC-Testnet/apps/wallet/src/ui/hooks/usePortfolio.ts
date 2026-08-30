import { useEffect, useState } from "react";
import {
  change24h,
  loadPortfolio,
  type Portfolio,
  recordSnapshot,
} from "../../core/services/portfolio";
import { loadPortfolioMarketChange24h } from "../../core/services/marketCatalog";
import { useWallet } from "../state/WalletContext";
import { useLiveRead } from "./useLiveRead";

/**
 * The HOME read. One `loadPortfolio` per block for the whole screen, so the
 * balance block and the asset list can never disagree with each other.
 *
 * The 24h figure is recorded and compared here rather than in the component:
 * a sample is only worth taking once per load, not once per render.
 */
export interface PortfolioView {
  portfolio: Portfolio | null;
  /** Fractional 24h change, or null while there is no baseline yet. */
  change: number | null;
  /** The first market/snapshot comparison is still resolving. */
  changeLoading: boolean;
  error: string | null;
  loading: boolean;
}

export function usePortfolio(): PortfolioView {
  const { address, tokens, tick, network } = useWallet();
  const read = useLiveRead(
    address ? () => loadPortfolio(address, tokens) : null,
    [address, tokens, tick],
    { identity: [address, tokens] },
  );
  const [changeState, setChangeState] = useState<{
    address: string;
    networkId: string;
    value: number | null;
    loading: boolean;
  } | null>(null);
  const total = read.data?.totalWad;
  const complete = read.data?.complete === true;

  useEffect(() => {
    const portfolio = read.data;
    if (!address || total === undefined || !complete || !portfolio) return;
    let cancelled = false;
    setChangeState((current) => current?.address === address && current.networkId === network.id
      ? { ...current, loading: true }
      : { address, networkId: network.id, value: null, loading: true });
    void (async () => {
      try {
        await recordSnapshot(address, total);
        const market = await loadPortfolioMarketChange24h(portfolio, network).catch(() => null);
        const next = market ?? await change24h(address, total);
        if (!cancelled) {
          setChangeState({ address, networkId: network.id, value: next, loading: false });
        }
      } catch {
        if (!cancelled) {
          setChangeState({ address, networkId: network.id, value: null, loading: false });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, complete, network, total]);

  const current = address !== null
    && changeState?.address === address
    && changeState.networkId === network.id;
  const change = current
    ? changeState.value
    : null;
  const changeLoading = current ? changeState.loading : Boolean(address && read.data?.complete);
  return {
    portfolio: read.data,
    change,
    changeLoading,
    error: read.error,
    loading: read.loading,
  };
}
