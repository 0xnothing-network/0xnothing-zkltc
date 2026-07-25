import type { Address, Hex } from "viem";

export type PumpStatus = "TRADING" | "READY" | "GRADUATED";
export type PumpTradeSide = "BUY" | "SELL";
export type PumpDataSource = "subgraph" | "rpc" | "unconfigured";
export type PumpMarketSort = "NEWEST" | "VOLUME" | "LAST_TRADE";

export const PUMP_CANDLE_PERIODS = [60, 900, 3_600, 14_400, 86_400] as const;
export type PumpCandlePeriod = (typeof PUMP_CANDLE_PERIODS)[number];
export const DEFAULT_PUMP_CANDLE_PERIOD: PumpCandlePeriod = 3_600;
export const MAX_PUMP_CANDLE_LIMIT = 500;
export const PUMP_CANDLE_LIMITS: Record<PumpCandlePeriod, number> = {
  60: 360,
  900: 200,
  3_600: 200,
  14_400: 200,
  86_400: 200,
};

export function normalizePumpCandlePeriod(value: number): PumpCandlePeriod {
  return PUMP_CANDLE_PERIODS.some((period) => period === value)
    ? (value as PumpCandlePeriod)
    : DEFAULT_PUMP_CANDLE_PERIOD;
}

export interface PumpMarket {
  id: Address;
  tokenAddress: Address;
  creator: Address;
  name: string;
  symbol: string;
  metadataURI: string;
  imageURI: string;
  status: PumpStatus;
  reserveNusd: string;
  reserveToken: string;
  virtualNusd: string;
  virtualToken: string;
  priceNusd: string;
  marketCapNusd: string;
  progressBps: number;
  createdAt: number;
  tradeCount: number;
  volumeNusd: string;
  lastTradeAt: number;
}

export interface PumpTrade {
  id: string;
  marketAddress: Address;
  tokenAddress: Address;
  trader: Address;
  side: PumpTradeSide;
  nusdAmount: string;
  userNusdAmount: string;
  tokenAmount: string;
  feeNusd: string;
  priceNusd: string;
  timestamp: number;
  blockNumber: number;
  logIndex: number;
  txHash: Hex;
}

export interface PumpCandle {
  id: string;
  marketAddress: Address;
  period: PumpCandlePeriod;
  bucket: number;
  timestamp: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volumeNusd: string;
  tradeCount: number;
}

export interface PumpHolder {
  account: Address;
  balance: string;
  isCreator: boolean;
}

export interface PumpListResponse {
  markets: PumpMarket[];
  source: PumpDataSource;
  configured: boolean;
  warning?: string;
}

export interface PumpMarketResponse {
  market: PumpMarket | null;
  source: PumpDataSource;
  configured: boolean;
  warning?: string;
}

export interface PumpTradesResponse {
  trades: PumpTrade[];
  source: PumpDataSource;
  configured: boolean;
  warning?: string;
}

export interface PumpCandlesResponse {
  candles: PumpCandle[];
  source: PumpDataSource;
  configured: boolean;
  warning?: string;
}

export interface PumpHoldersResponse {
  holders: PumpHolder[];
  creator: Address;
  totalSupply: string;
  curveBalance: string;
  holderCount: number;
  source: PumpDataSource;
  configured: boolean;
  warning?: string;
}

export interface PumpProtocolStats {
  marketCount: number;
  tradingCount: number;
  readyCount: number;
  graduatedCount: number;
  tradeCount: number;
  volumeNusd: string;
  feesNusd: string;
}

export interface PumpStatsResponse {
  stats: PumpProtocolStats;
  source: PumpDataSource;
  configured: boolean;
  warning?: string;
}

export function statusFromNumber(value: number | bigint | string): PumpStatus {
  const status = Number(value);
  if (status === 3) return "GRADUATED";
  if (status === 2) return "READY";
  return "TRADING";
}

export function emptyPumpMarket(tokenAddress: Address): PumpMarket {
  return {
    id: tokenAddress,
    tokenAddress,
    creator: "0x0000000000000000000000000000000000000000",
    name: "Unknown token",
    symbol: "TOKEN",
    metadataURI: "",
    imageURI: "",
    status: "TRADING",
    reserveNusd: "0",
    reserveToken: "0",
    virtualNusd: "0",
    virtualToken: "0",
    priceNusd: "0",
    marketCapNusd: "0",
    progressBps: 0,
    createdAt: 0,
    tradeCount: 0,
    volumeNusd: "0",
    lastTradeAt: 0,
  };
}
