export interface CandlePoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ActivityPoint {
  id: string;
  timestamp: number;
  type: "swap" | "add" | "remove" | "stake" | "withdraw" | "reward";
  pair: string;
  amount0: string;
  amount1: string;
  account?: string;
  transactionHash: string;
  logIndex: number;
}

export interface PoolTokenPoint {
  id: `0x${string}`;
  symbol: string;
  name: string;
  decimals: number;
  imageUrl?: string;
}

export interface PoolPoint {
  id: `0x${string}`;
  reserve0: string;
  reserve1: string;
  totalSupply: string;
  volumeNusd: string;
  swapCount: string;
  protectedBootstrap: boolean;
  bootstrapped: boolean;
  token0: PoolTokenPoint;
  token1: PoolTokenPoint;
  /** Spot price of the non-NUSD token in NUSD (undefined if no liquidity) */
  priceNusd?: string;
  /** Source used for the displayed market price. Canonical markets use DIA. */
  priceSource?: "oracle" | "dex";
  /** UNIX timestamp supplied by the oracle adapter for canonical markets. */
  oracleUpdatedAt?: number;
  /** Approximate TVL in NUSD: nusd_reserve * 2 */
  tvlNusd?: string;
  /** Rolling 24-hour NUSD trading volume from indexed candles */
  volume24hNusd?: string;
  /** Percentage price change over the last 24 hours */
  priceChange24h?: number;
}

export interface DataMeta {
  source: "goldsky" | "rpc" | "unconfigured";
  indexedBlock: number | null;
  generatedAt: string;
  rpcTail: {
    status: "pending" | "merged" | "capped" | "unavailable";
    fromBlock: number;
    toBlock?: number;
    merged: boolean;
    eventCount?: number;
  };
  priceSource?: "oracle" | "dex";
  oracle?: {
    updatedAt: number;
    roundId: string;
  };
}

export interface DataEnvelope<T> {
  data: T;
  meta: DataMeta;
  warning?: string;
}
