import "server-only";

import type { Address } from "viem";
import {
  PUMP_CONFIGURED,
  PUMP_FACTORY_ADDRESS,
  PUMP_SUBGRAPH_URL,
  ZERO_ADDRESS,
} from "@/features/pump/config";
import {
  MAX_PUMP_CANDLE_LIMIT,
  normalizePumpCandlePeriod,
  PUMP_CANDLE_LIMITS,
  type PumpCandlesResponse,
  type PumpHoldersResponse,
  type PumpListResponse,
  type PumpMarketResponse,
  type PumpMarketSort,
  type PumpStatsResponse,
  type PumpTradesResponse,
} from "@/features/pump/types";
import { aggregateCandles, mergeLiveTradesIntoCandles, mergePumpTrades } from "./aggregate";
import { HOLDER_GRAPH_TIMEOUT_MS, RPC_TRADE_LOOKBACK } from "./constants";
import {
  GRAPH_MARKET_ORDER,
  MARKET_FIELDS,
  emptyProtocolStats,
  graphFetch,
  normalizeGraphCandle,
  normalizeGraphMarket,
  normalizeGraphProtocol,
  normalizeGraphTrade,
  type GraphCandle,
  type GraphCandleMarket,
  type GraphHolderMarket,
  type GraphMarket,
  type GraphMeta,
  type GraphProtocol,
  type GraphTokenBalance,
  type GraphTrade,
} from "./graph";
import { emptyHoldersResponse, mergeCreatorHolder, normalizeGraphHolder } from "./holders";
import { getRpcHolders } from "./rpcHolders";
import { getRpcMarkets, getRpcProtocolStats, hydrateRpcMarket } from "./rpcMarkets";
import { getRpcTrades, getRpcTradesAfterBlock } from "./rpcTrades";
import {
  clamp,
  decimalString,
  integerString,
  safeAddress,
  safeBigInt,
  safeNumber,
  warningMessage,
} from "./values";

/**
 * The pump read API used by the route handlers. Every entry point prefers the
 * subgraph, overlays the live RPC head where staleness would show, and falls
 * back to RPC-only reads when the index is unavailable — reporting which source
 * answered so the UI can surface a warning instead of silently going stale.
 *
 * Supporting layers: ./graph (subgraph transport and payload normalizers),
 * ./rpcMarkets, ./rpcTrades, ./rpcHolders (contract and log fallbacks),
 * ./aggregate (candle folding), ./holders (holder shaping), ./values
 * (coercion helpers), ./constants (limits and timeouts).
 */

export async function getPumpMarkets(options?: {
  limit?: number;
  skip?: number;
  creator?: Address;
  sort?: PumpMarketSort;
}): Promise<PumpListResponse> {
  if (!PUMP_CONFIGURED) {
    return { markets: [], source: "unconfigured", configured: false };
  }

  const limit = clamp(options?.limit ?? 60, 1, 200);
  const skip = clamp(options?.skip ?? 0, 0, 1_000_000);
  const sort = options?.sort ?? "NEWEST";
  const graphOrder = GRAPH_MARKET_ORDER[sort];
  if (PUMP_SUBGRAPH_URL) {
    try {
      const declaration = options?.creator ? "$creator: Bytes!, " : "";
      const where = options?.creator ? "where: { creator: $creator }," : "";
      const variables: Record<string, unknown> = { first: limit, skip };
      if (options?.creator) variables.creator = options.creator.toLowerCase();
      const payload = await graphFetch<{ markets: GraphMarket[] }>(
        `query PumpMarkets(${declaration}$first: Int!, $skip: Int!) {
          markets(first: $first, skip: $skip, ${where} orderBy: ${graphOrder}, orderDirection: desc) {
            ${MARKET_FIELDS}
          }
        }`,
        variables,
      );
      return {
        markets: payload.markets.map(normalizeGraphMarket),
        source: "subgraph",
        configured: true,
      };
    } catch (error) {
      const fallback = await getRpcMarkets(limit, skip, options?.creator, sort);
      return {
        markets: fallback,
        source: "rpc",
        configured: true,
        warning: warningMessage(error, "Subgraph unavailable; using live RPC data."),
      };
    }
  }

  return {
    markets: await getRpcMarkets(limit, skip, options?.creator, sort),
    source: "rpc",
    configured: true,
    warning: "Pump subgraph is not configured; using live RPC data.",
  };
}

export async function getPumpStats(): Promise<PumpStatsResponse> {
  if (!PUMP_CONFIGURED) {
    return { stats: emptyProtocolStats(), source: "unconfigured", configured: false };
  }

  if (PUMP_SUBGRAPH_URL) {
    try {
      const payload = await graphFetch<{ protocol: GraphProtocol | null; _meta: GraphMeta }>(
        `query PumpProtocolStats {
          _meta { block { number } hasIndexingErrors }
          protocol(id: "global") {
            tokenCount activeTokenCount readyTokenCount graduatedTokenCount
            tradeCount buyCount sellCount totalVolumeNusd
            totalTradeFeesNusd totalCreationFeesNusd totalFeesNusd
            totalFeesWithdrawnNusd updatedAt
          }
        }`,
        {},
      );
      if (payload._meta.hasIndexingErrors) {
        throw new Error("Pump statistics index reported an error.");
      }
      return {
        stats: payload.protocol ? normalizeGraphProtocol(payload.protocol) : emptyProtocolStats(),
        source: "subgraph",
        configured: true,
        indexedBlock: safeNumber(payload._meta.block.number),
        updatedAt: payload.protocol ? safeNumber(payload.protocol.updatedAt) : undefined,
      };
    } catch (error) {
      return {
        stats: await getRpcProtocolStats(),
        source: "rpc",
        configured: true,
        warning: warningMessage(
          error,
          "Subgraph unavailable; market and volume totals use live RPC. Trade and lifetime revenue totals are unavailable.",
        ),
      };
    }
  }

  return {
    stats: await getRpcProtocolStats(),
    source: "rpc",
    configured: true,
    warning: "Pump subgraph is not configured; trade and lifetime revenue totals are unavailable.",
  };
}

export async function getPumpMarket(token: Address): Promise<PumpMarketResponse> {
  if (!PUMP_CONFIGURED) {
    return { market: null, source: "unconfigured", configured: false };
  }

  if (PUMP_SUBGRAPH_URL) {
    try {
      const payload = await graphFetch<{ market: GraphMarket | null }>(
        `query PumpMarket($id: ID!) {
          market(id: $id) { ${MARKET_FIELDS} }
        }`,
        { id: token.toLowerCase() },
      );
      if (payload.market) {
        const indexedMarket = normalizeGraphMarket(payload.market);
        const liveMarket = await hydrateRpcMarket(token).catch(() => null);
        return {
          market: liveMarket
            ? {
                ...indexedMarket,
                status: liveMarket.status,
                reserveNusd: liveMarket.reserveNusd,
                reserveToken: liveMarket.reserveToken,
                virtualNusd: liveMarket.virtualNusd,
                virtualToken: liveMarket.virtualToken,
                priceNusd: liveMarket.priceNusd,
                marketCapNusd: liveMarket.marketCapNusd,
                progressBps: liveMarket.progressBps,
                dex: liveMarket.dex,
                dexPairId: liveMarket.dexPairId,
                pool: liveMarket.pool,
              }
            : indexedMarket,
          source: "subgraph",
          configured: true,
          warning: liveMarket ? undefined : "Live market state is temporarily unavailable.",
        };
      }
    } catch (error) {
      const market = await hydrateRpcMarket(token).catch(() => null);
      return {
        market,
        source: "rpc",
        configured: true,
        warning: warningMessage(error, "Subgraph unavailable; using live RPC data."),
      };
    }
  }

  return {
    market: await hydrateRpcMarket(token).catch(() => null),
    source: "rpc",
    configured: true,
    warning: PUMP_SUBGRAPH_URL ? undefined : "Pump subgraph is not configured.",
  };
}

export async function getPumpTrades(options: {
  token?: Address;
  trader?: Address;
  limit?: number;
  skip?: number;
}): Promise<PumpTradesResponse> {
  if (!PUMP_CONFIGURED) {
    return { trades: [], source: "unconfigured", configured: false };
  }

  const limit = clamp(options.limit ?? 40, 1, 200);
  const skip = clamp(options.skip ?? 0, 0, 10_000);
  if (PUMP_SUBGRAPH_URL) {
    try {
      const filters: string[] = [];
      const variables: Record<string, unknown> = { first: limit, skip };
      const declarations = ["$first: Int!", "$skip: Int!"];
      if (options.token) {
        filters.push("market: $market");
        declarations.unshift("$market: Bytes!");
        variables.market = options.token.toLowerCase();
      }
      if (options.trader) {
        filters.push("trader: $trader");
        declarations.unshift("$trader: Bytes!");
        variables.trader = options.trader.toLowerCase();
      }
      const where = filters.length > 0 ? `where: { ${filters.join(", ")} },` : "";
      const payload = await graphFetch<{ trades: GraphTrade[]; _meta: GraphMeta }>(
        `query PumpTrades(${declarations.join(", ")}) {
          _meta { block { number } hasIndexingErrors }
          trades(first: $first, skip: $skip, ${where} orderBy: timestamp, orderDirection: desc) {
            id market { id token } trader side nusdAmount userNusdAmount tokenAmount
            feeNusd priceNusd timestamp blockNumber logIndex txHash
          }
        }`,
        variables,
      );
      if (payload._meta.hasIndexingErrors) {
        return {
          trades: await getRpcTrades(options.token, limit, skip, RPC_TRADE_LOOKBACK, options.trader),
          source: "rpc",
          configured: true,
          warning: "The trade index reported an error; recent trades are using live RPC logs.",
        };
      }
      let trades = payload.trades.map(normalizeGraphTrade);
      let warning: string | undefined;
      const indexedBlock = safeBigInt(payload._meta.block.number);
      const canOverlayLiveTrades = Boolean(
        skip === 0 &&
        indexedBlock > 0n &&
        (options.token || (options.trader && payload.trades.length < limit)),
      );
      if (canOverlayLiveTrades) {
        try {
          const liveHead = await getRpcTradesAfterBlock(
            options.token,
            indexedBlock,
            options.trader,
          );
          trades = mergePumpTrades(liveHead.trades, trades).slice(0, limit);
          if (liveHead.truncated) {
            warning = "Live trade updates were limited because the subgraph is far behind.";
          }
        } catch (error) {
          warning = warningMessage(
            error,
            "Live RPC updates are temporarily delayed; indexed trades remain available.",
          );
        }
      }
      return {
        trades,
        source: "subgraph",
        configured: true,
        warning,
      };
    } catch (error) {
      return {
        trades: await getRpcTrades(options.token, limit, skip, RPC_TRADE_LOOKBACK, options.trader),
        source: "rpc",
        configured: true,
        warning: warningMessage(error, "Subgraph unavailable; using recent RPC trades."),
      };
    }
  }

  return {
    trades: await getRpcTrades(options.token, limit, skip, RPC_TRADE_LOOKBACK, options.trader),
    source: "rpc",
    configured: true,
    warning: "Pump subgraph is not configured; history is limited to recent RPC logs.",
  };
}

export async function getPumpHolders(options: {
  token: Address;
  limit?: number;
}): Promise<PumpHoldersResponse> {
  if (!PUMP_CONFIGURED) return emptyHoldersResponse(ZERO_ADDRESS, false);

  const limit = clamp(options.limit ?? 10, 1, 50);
  if (PUMP_SUBGRAPH_URL) {
    try {
      const payload = await graphFetch<{
        market: GraphHolderMarket | null;
        tokenBalances: GraphTokenBalance[];
        curvePositions: GraphTokenBalance[];
      }>(
        `query PumpHolders($market: Bytes!, $factory: Bytes!, $first: Int!) {
          market(id: $market) { creator totalSupply holderCount }
          tokenBalances(
            first: $first
            where: { market: $market, balance_gt: 0, holder_not: $factory }
            orderBy: balance
            orderDirection: desc
          ) { holder balance }
          curvePositions: tokenBalances(first: 1, where: { market: $market, holder: $factory }) {
            holder balance
          }
        }`,
        {
          market: options.token.toLowerCase(),
          factory: PUMP_FACTORY_ADDRESS.toLowerCase(),
          first: limit,
        },
        HOLDER_GRAPH_TIMEOUT_MS,
      );
      if (!payload.market) throw new Error("Holder market is not indexed");

      const creator = safeAddress(payload.market.creator);
      const indexedHolders = payload.tokenBalances.map((position) =>
        normalizeGraphHolder(position, creator));
      const indexedCreator = indexedHolders.find((holder) => holder.isCreator);
      let creatorBalance = indexedCreator?.balance ?? "0";
      if (!indexedCreator) {
        const creatorPayload = await graphFetch<{ creatorPositions: GraphTokenBalance[] }>(
          `query PumpCreatorBalance($market: Bytes!, $creator: Bytes!) {
            creatorPositions: tokenBalances(first: 1, where: { market: $market, holder: $creator }) {
              holder balance
            }
          }`,
          { market: options.token.toLowerCase(), creator: creator.toLowerCase() },
          HOLDER_GRAPH_TIMEOUT_MS,
        );
        creatorBalance = creatorPayload.creatorPositions[0]?.balance ?? "0";
      }
      const holders = mergeCreatorHolder(
        indexedHolders,
        creator,
        creatorBalance,
      );
      return {
        holders,
        creator,
        totalSupply: integerString(payload.market.totalSupply),
        curveBalance: integerString(payload.curvePositions[0]?.balance ?? "0"),
        holderCount: safeNumber(payload.market.holderCount),
        source: "subgraph",
        configured: true,
      };
    } catch (error) {
      const fallback = await getRpcHolders(options.token, limit);
      const indexWarning = warningMessage(
        error,
        "Holder index unavailable; using live token transfers.",
      );
      return {
        ...fallback,
        warning: fallback.warning ? `${indexWarning} ${fallback.warning}` : indexWarning,
      };
    }
  }

  const fallback = await getRpcHolders(options.token, limit);
  return {
    ...fallback,
    warning: fallback.warning ?? "Pump subgraph is not configured; holders use live token transfers.",
  };
}

export async function getPumpCandles(options: {
  token: Address;
  period: number;
  limit?: number;
}): Promise<PumpCandlesResponse> {
  if (!PUMP_CONFIGURED) {
    return { candles: [], source: "unconfigured", configured: false };
  }

  const period = normalizePumpCandlePeriod(options.period);
  const requestedLimit = options.limit ?? PUMP_CANDLE_LIMITS[period];
  const limit = clamp(
    Number.isFinite(requestedLimit)
      ? Math.trunc(requestedLimit)
      : PUMP_CANDLE_LIMITS[period],
    1,
    MAX_PUMP_CANDLE_LIMIT,
  );
  if (PUMP_SUBGRAPH_URL) {
    try {
      const payload = await graphFetch<{
        candles: GraphCandle[];
        market: GraphCandleMarket | null;
        _meta: GraphMeta;
      }>(
        `query PumpCandles($market: Bytes!, $period: Int!, $first: Int!) {
          _meta { block { number } hasIndexingErrors }
          market(id: $market) { priceNusd }
          candles(
            first: $first
            where: { market: $market, period: $period }
            orderBy: timestamp
            orderDirection: desc
          ) {
            id market { id } period bucket timestamp open high low close volumeNusd tradeCount
          }
        }`,
        { market: options.token.toLowerCase(), period: period / 60, first: limit },
      );
      let candles = payload.candles
        .map((candle) => normalizeGraphCandle(candle, period))
        .reverse();
      let source: PumpCandlesResponse["source"] = "subgraph";
      let warning: string | undefined;
      if (payload._meta.hasIndexingErrors) {
        const rpcTrades = await getRpcTrades(options.token, 500, 0, RPC_TRADE_LOOKBACK);
        return {
          candles: aggregateCandles(rpcTrades, period).slice(-limit),
          source: "rpc",
          configured: true,
          warning: "The candle index reported an error; chart data is using live RPC trades.",
        };
      }
      if (period === 60 && payload.candles.length === 0) {
        const rpcTrades = await getRpcTrades(
          options.token,
          Math.min(500, Math.max(limit, 200)),
          0,
          RPC_TRADE_LOOKBACK,
        );
        candles = aggregateCandles(rpcTrades, period).slice(-limit);
        source = "rpc";
        warning = "The 1m view uses live RPC trades until the candle index is reindexed.";
      }

      const indexedBlock = safeBigInt(payload._meta?.block.number);
      if (source === "subgraph" && indexedBlock > 0n) {
        try {
          const liveHead = await getRpcTradesAfterBlock(options.token, indexedBlock);
          candles = mergeLiveTradesIntoCandles(
            candles,
            liveHead.trades,
            period,
            limit,
            decimalString(payload.market?.priceNusd ?? "0"),
          );
          if (liveHead.truncated) {
            warning = "The live RPC overlay was limited because the subgraph is far behind.";
          }
        } catch (error) {
          warning = warningMessage(
            error,
            "Live RPC updates are temporarily delayed; indexed chart history remains available.",
          );
        }
      }

      return {
        candles,
        source,
        configured: true,
        warning,
      };
    } catch (error) {
      const trades = await getRpcTrades(options.token, 500, 0, RPC_TRADE_LOOKBACK);
      return {
        candles: aggregateCandles(trades, period).slice(-limit),
        source: "rpc",
        configured: true,
        warning: warningMessage(error, "Subgraph unavailable; chart uses recent RPC trades."),
      };
    }
  }

  const trades = await getRpcTrades(options.token, 500, 0, RPC_TRADE_LOOKBACK);
  return {
    candles: aggregateCandles(trades, period).slice(-limit),
    source: "rpc",
    configured: true,
    warning: "Pump subgraph is not configured; chart history is limited.",
  };
}
