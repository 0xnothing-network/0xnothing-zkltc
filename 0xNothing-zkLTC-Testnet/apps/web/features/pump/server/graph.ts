import "server-only";

import type { Hex } from "viem";
import { PUMP_SUBGRAPH_URL } from "@/features/pump/config";
import { readLimitedJson } from "@/lib/server/readLimitedJson";
import {
  emptyPumpMarket,
  type PumpCandle,
  type PumpCandlePeriod,
  type PumpMarket,
  type PumpMarketSort,
  type PumpProtocolStats,
  type PumpStatus,
  type PumpTrade,
} from "@/features/pump/types";
import { GRAPH_TIMEOUT_MS } from "./constants";
import {
  ZERO_HASH,
  clamp,
  decimalString,
  integerString,
  safeAddress,
  safeNumber,
} from "./values";

/**
 * The pump subgraph transport and the payload shapes it returns, together with
 * the normalizers that turn those raw string fields into the domain types the
 * UI consumes.
 */

interface GraphResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

const MAX_GRAPH_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface GraphMeta {
  block: { number: number | string };
  hasIndexingErrors: boolean;
}

export interface GraphMarket {
  id: string;
  token: string;
  creator: string;
  name: string;
  symbol: string;
  metadataURI: string;
  imageURI: string;
  status: string;
  reserveNusd: string;
  reserveToken: string;
  virtualNusd: string;
  virtualToken: string;
  priceNusd: string;
  marketCapNusd: string;
  progressBps: number;
  createdAt: string;
  tradeCount: string;
  volumeNusd: string;
  lastTradeAt: string;
}

export interface GraphTrade {
  id: string;
  market: { id: string; token: string };
  trader: string;
  side: string;
  nusdAmount: string;
  userNusdAmount: string;
  tokenAmount: string;
  feeNusd: string;
  priceNusd: string;
  timestamp: string;
  blockNumber: string;
  logIndex: string;
  txHash: string;
}

export interface GraphCandle {
  id: string;
  market: { id: string };
  period: number;
  bucket: string;
  timestamp: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volumeNusd: string;
  tradeCount: string;
}

export interface GraphCandleMarket {
  priceNusd: string;
}

export interface GraphTokenBalance {
  holder: string;
  balance: string;
}

export interface GraphHolderMarket {
  creator: string;
  totalSupply: string;
  holderCount: string;
}

export interface GraphProtocol {
  tokenCount: string;
  activeTokenCount: string;
  readyTokenCount: string;
  graduatedTokenCount: string;
  tradeCount: string;
  buyCount: string;
  sellCount: string;
  totalVolumeNusd: string;
  totalTradeFeesNusd: string;
  totalCreationFeesNusd: string;
  totalFeesNusd: string;
  totalFeesWithdrawnNusd: string;
  updatedAt: string;
}

export const MARKET_FIELDS = `
  id token creator name symbol metadataURI imageURI status
  reserveNusd reserveToken virtualNusd virtualToken priceNusd marketCapNusd
  progressBps createdAt tradeCount volumeNusd lastTradeAt
`;

export const GRAPH_MARKET_ORDER: Record<PumpMarketSort, "createdAt" | "volumeNusd" | "lastTradeAt"> = {
  NEWEST: "createdAt",
  VOLUME: "volumeNusd",
  LAST_TRADE: "lastTradeAt",
};

export async function graphFetch<T>(
  query: string,
  variables: Record<string, unknown>,
  timeoutMs = GRAPH_TIMEOUT_MS,
): Promise<T> {
  const response = await fetch(PUMP_SUBGRAPH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Pump subgraph returned HTTP ${response.status}`);
  const payload = await readLimitedJson<GraphResponse<T>>(
    response,
    MAX_GRAPH_RESPONSE_BYTES,
  );
  if (payload.errors?.length || !payload.data) {
    throw new Error(payload.errors?.[0]?.message || "Pump subgraph returned no data");
  }
  return payload.data;
}

export function normalizeGraphMarket(market: GraphMarket): PumpMarket {
  const tokenAddress = safeAddress(market.token || market.id);
  return {
    ...emptyPumpMarket(tokenAddress),
    id: safeAddress(market.id || market.token),
    tokenAddress,
    creator: safeAddress(market.creator),
    name: market.name || "Unknown token",
    symbol: market.symbol || "TOKEN",
    metadataURI: market.metadataURI || "",
    imageURI: market.imageURI || "",
    status: normalizeGraphStatus(market.status),
    reserveNusd: integerString(market.reserveNusd),
    reserveToken: integerString(market.reserveToken),
    virtualNusd: integerString(market.virtualNusd),
    virtualToken: integerString(market.virtualToken),
    priceNusd: decimalString(market.priceNusd),
    marketCapNusd: integerString(market.marketCapNusd),
    progressBps: clamp(Number(market.progressBps), 0, 10_000),
    createdAt: safeNumber(market.createdAt),
    tradeCount: safeNumber(market.tradeCount),
    volumeNusd: integerString(market.volumeNusd),
    lastTradeAt: safeNumber(market.lastTradeAt),
  };
}

export function normalizeGraphTrade(trade: GraphTrade): PumpTrade {
  const tokenAddress = safeAddress(trade.market.token || trade.market.id);
  return {
    id: trade.id,
    marketAddress: safeAddress(trade.market.id),
    tokenAddress,
    trader: safeAddress(trade.trader),
    side: trade.side === "SELL" ? "SELL" : "BUY",
    nusdAmount: integerString(trade.nusdAmount),
    userNusdAmount: integerString(trade.userNusdAmount),
    tokenAmount: integerString(trade.tokenAmount),
    feeNusd: integerString(trade.feeNusd),
    priceNusd: decimalString(trade.priceNusd),
    timestamp: safeNumber(trade.timestamp),
    blockNumber: safeNumber(trade.blockNumber),
    logIndex: safeNumber(trade.logIndex),
    txHash: /^0x[0-9a-fA-F]{64}$/.test(trade.txHash) ? (trade.txHash as Hex) : ZERO_HASH,
  };
}

export function normalizeGraphCandle(
  candle: GraphCandle,
  periodSeconds: PumpCandlePeriod,
): PumpCandle {
  return {
    id: candle.id,
    marketAddress: safeAddress(candle.market.id),
    period: periodSeconds,
    bucket: safeNumber(candle.bucket),
    timestamp: safeNumber(candle.timestamp),
    open: decimalString(candle.open),
    high: decimalString(candle.high),
    low: decimalString(candle.low),
    close: decimalString(candle.close),
    volumeNusd: integerString(candle.volumeNusd),
    tradeCount: safeNumber(candle.tradeCount),
  };
}

export function normalizeGraphProtocol(protocol: GraphProtocol): PumpProtocolStats {
  const activeCount = safeNumber(protocol.activeTokenCount);
  const readyCount = safeNumber(protocol.readyTokenCount);
  return {
    marketCount: safeNumber(protocol.tokenCount),
    tradingCount: Math.max(0, activeCount - readyCount),
    readyCount,
    graduatedCount: safeNumber(protocol.graduatedTokenCount),
    tradeCount: safeNumber(protocol.tradeCount),
    buyCount: safeNumber(protocol.buyCount),
    sellCount: safeNumber(protocol.sellCount),
    volumeNusd: integerString(protocol.totalVolumeNusd),
    feesNusd: integerString(protocol.totalFeesNusd),
    tradeFeesNusd: integerString(protocol.totalTradeFeesNusd),
    creationFeesNusd: integerString(protocol.totalCreationFeesNusd),
    withdrawnFeesNusd: integerString(protocol.totalFeesWithdrawnNusd),
  };
}

export function emptyProtocolStats(): PumpProtocolStats {
  return {
    marketCount: 0,
    tradingCount: 0,
    readyCount: 0,
    graduatedCount: 0,
    tradeCount: 0,
    buyCount: 0,
    sellCount: 0,
    volumeNusd: "0",
    feesNusd: "0",
    tradeFeesNusd: "0",
    creationFeesNusd: "0",
    withdrawnFeesNusd: "0",
  };
}

function normalizeGraphStatus(value: string): PumpStatus {
  if (value === "GRADUATED") return "GRADUATED";
  if (value === "READY") return "READY";
  return "TRADING";
}
