import "server-only";

import {
  formatUnits,
  getAddress,
  parseAbiItem,
  type Address,
  type Hex,
} from "viem";
import { publicClient } from "@/lib/contract";
import {
  PUMP_CONFIGURED,
  PUMP_FACTORY_ADDRESS,
  PUMP_START_BLOCK,
  PUMP_SUBGRAPH_URL,
  ZERO_ADDRESS,
} from "@/features/pump/config";
import { pumpTokenAbi, zeroXPumpAbi } from "@/features/pump/abis";
import {
  emptyPumpMarket,
  MAX_PUMP_CANDLE_LIMIT,
  normalizePumpCandlePeriod,
  PUMP_CANDLE_LIMITS,
  statusFromNumber,
  type PumpCandle,
  type PumpCandlePeriod,
  type PumpCandlesResponse,
  type PumpHolder,
  type PumpHoldersResponse,
  type PumpListResponse,
  type PumpMarket,
  type PumpMarketResponse,
  type PumpMarketSort,
  type PumpProtocolStats,
  type PumpStatsResponse,
  type PumpStatus,
  type PumpTrade,
  type PumpTradesResponse,
} from "@/features/pump/types";

const MAX_MARKETS = 500;
const RPC_TRADE_LOOKBACK = 100_000n;
const RPC_LOG_BLOCK_CHUNK = 16_384n;
const MAX_RPC_HOLDER_CANDIDATES = 10_000;
const RPC_HOLDER_LOG_CONCURRENCY = 4;
const GRAPH_TIMEOUT_MS = 8_000;
const HOLDER_GRAPH_TIMEOUT_MS = 2_500;
const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;
const TOKEN_TRADED_EVENT = parseAbiItem(
  "event TokenTraded(address indexed token,address indexed trader,bool indexed isBuy,uint256 tokenAmount,uint256 curveNusdAmount,uint256 userNusdAmount,uint256 feeNusd,uint256 realNusdReserveAfter,uint256 tokenReserveAfter,uint256 virtualNusdReserveAfter,uint256 virtualTokenReserveAfter,uint256 circulatingSupplyAfter,uint256 spotPriceNusdWad,uint256 curveProgressBps)",
);
const TOKEN_TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from,address indexed to,uint256 value)",
);

interface GraphResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

interface GraphMarket {
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

interface GraphTrade {
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
  txHash: string;
}

interface GraphCandle {
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

interface GraphTokenBalance {
  holder: string;
  balance: string;
}

interface GraphHolderMarket {
  creator: string;
  totalSupply: string;
  holderCount: string;
}

interface GraphProtocol {
  tokenCount: string;
  activeTokenCount: string;
  readyTokenCount: string;
  graduatedTokenCount: string;
  tradeCount: string;
  totalVolumeNusd: string;
  totalFeesNusd: string;
}

type RpcMarketState = readonly [
  Address,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  number,
  Address,
  Hex,
  Address,
];

const MARKET_FIELDS = `
  id token creator name symbol metadataURI imageURI status
  reserveNusd reserveToken virtualNusd virtualToken priceNusd marketCapNusd
  progressBps createdAt tradeCount volumeNusd lastTradeAt
`;

const GRAPH_MARKET_ORDER: Record<PumpMarketSort, "createdAt" | "volumeNusd" | "lastTradeAt"> = {
  NEWEST: "createdAt",
  VOLUME: "volumeNusd",
  LAST_TRADE: "lastTradeAt",
};

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
      const payload = await graphFetch<{ protocol: GraphProtocol | null }>(
        `query PumpProtocolStats {
          protocol(id: "global") {
            tokenCount activeTokenCount readyTokenCount graduatedTokenCount
            tradeCount totalVolumeNusd totalFeesNusd
          }
        }`,
        {},
      );
      return {
        stats: payload.protocol ? normalizeGraphProtocol(payload.protocol) : emptyProtocolStats(),
        source: "subgraph",
        configured: true,
      };
    } catch (error) {
      return {
        stats: await getRpcProtocolStats(),
        source: "rpc",
        configured: true,
        warning: warningMessage(error, "Subgraph unavailable; using live RPC market totals."),
      };
    }
  }

  return {
    stats: await getRpcProtocolStats(),
    source: "rpc",
    configured: true,
    warning: "Pump subgraph is not configured; trade and fee totals are unavailable.",
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
        return {
          market: normalizeGraphMarket(payload.market),
          source: "subgraph",
          configured: true,
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
      const where = options.token ? "where: { market: $market }," : "";
      const variables: Record<string, unknown> = { first: limit, skip };
      const declaration = options.token ? "$market: Bytes!, " : "";
      if (options.token) variables.market = options.token.toLowerCase();
      const payload = await graphFetch<{ trades: GraphTrade[] }>(
        `query PumpTrades(${declaration}$first: Int!, $skip: Int!) {
          trades(first: $first, skip: $skip, ${where} orderBy: timestamp, orderDirection: desc) {
            id market { id token } trader side nusdAmount userNusdAmount tokenAmount
            feeNusd priceNusd timestamp blockNumber txHash
          }
        }`,
        variables,
      );
      return {
        trades: payload.trades.map(normalizeGraphTrade),
        source: "subgraph",
        configured: true,
      };
    } catch (error) {
      return {
        trades: await getRpcTrades(options.token, limit, skip),
        source: "rpc",
        configured: true,
        warning: warningMessage(error, "Subgraph unavailable; using recent RPC trades."),
      };
    }
  }

  return {
    trades: await getRpcTrades(options.token, limit, skip),
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
      const payload = await graphFetch<{ candles: GraphCandle[] }>(
        `query PumpCandles($market: Bytes!, $period: Int!, $first: Int!) {
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
      if (period === 60 && payload.candles.length === 0) {
        const tradeHistory = await getPumpTrades({
          token: options.token,
          limit: 200,
          skip: 0,
        });
        return {
          candles: aggregateCandles(tradeHistory.trades, period).slice(-limit),
          source: tradeHistory.source,
          configured: true,
          warning: tradeHistory.warning
            ?? "The 1m view uses indexed trades until the candle index is reindexed.",
        };
      }
      return {
        candles: payload.candles.map((candle) => normalizeGraphCandle(candle, period)).reverse(),
        source: "subgraph",
        configured: true,
      };
    } catch (error) {
      const trades = await getRpcTrades(options.token, 500, 0);
      return {
        candles: aggregateCandles(trades, period).slice(-limit),
        source: "rpc",
        configured: true,
        warning: warningMessage(error, "Subgraph unavailable; chart uses recent RPC trades."),
      };
    }
  }

  const trades = await getRpcTrades(options.token, 500, 0);
  return {
    candles: aggregateCandles(trades, period).slice(-limit),
    source: "rpc",
    configured: true,
    warning: "Pump subgraph is not configured; chart history is limited.",
  };
}

async function getRpcMarkets(
  limit: number,
  skip: number,
  creator?: Address,
  sort: PumpMarketSort = "NEWEST",
): Promise<PumpMarket[]> {
  const tokens = (await publicClient.readContract({
    address: PUMP_FACTORY_ADDRESS,
    abi: zeroXPumpAbi,
    functionName: creator ? "getTokensByCreator" : "getAllTokens",
    args: creator ? [creator] : undefined,
  })) as readonly Address[];
  const newestFirst = [...tokens].reverse().slice(0, MAX_MARKETS);
  const orderedTokens = sort === "VOLUME"
    ? await orderRpcTokensByVolume(newestFirst)
    : newestFirst;
  const page = orderedTokens.slice(skip, skip + limit);
  const markets = await Promise.all(page.map((token) => hydrateRpcMarket(token).catch(() => null)));
  return markets.filter((market): market is PumpMarket => market !== null);
}

async function orderRpcTokensByVolume(tokens: Address[]): Promise<Address[]> {
  const ranked: Array<{ token: Address; volume: bigint; createdAt: bigint }> = [];
  for (let start = 0; start < tokens.length; start += 100) {
    const page = tokens.slice(start, start + 100);
    const results = await publicClient.multicall({
      allowFailure: true,
      contracts: page.map((token) => ({
        address: PUMP_FACTORY_ADDRESS,
        abi: zeroXPumpAbi,
        functionName: "markets" as const,
        args: [token] as const,
      })),
    });
    results.forEach((result, index) => {
      const state = result.status === "success" ? (result.result as RpcMarketState) : null;
      ranked.push({
        token: page[index],
        volume: state?.[5] ?? 0n,
        createdAt: state?.[6] ?? 0n,
      });
    });
  }
  ranked.sort((left, right) => {
    if (left.volume !== right.volume) return left.volume > right.volume ? -1 : 1;
    if (left.createdAt !== right.createdAt) return left.createdAt > right.createdAt ? -1 : 1;
    return left.token.toLowerCase().localeCompare(right.token.toLowerCase());
  });
  return ranked.map((entry) => entry.token);
}

async function getRpcProtocolStats(): Promise<PumpProtocolStats> {
  const tokens = (await publicClient.readContract({
    address: PUMP_FACTORY_ADDRESS,
    abi: zeroXPumpAbi,
    functionName: "getAllTokens",
  })) as readonly Address[];
  const stats = emptyProtocolStats();
  stats.marketCount = tokens.length;

  for (let start = 0; start < tokens.length; start += 100) {
    const page = tokens.slice(start, start + 100);
    const results = await publicClient.multicall({
      allowFailure: true,
      contracts: page.map((token) => ({
        address: PUMP_FACTORY_ADDRESS,
        abi: zeroXPumpAbi,
        functionName: "markets" as const,
        args: [token] as const,
      })),
    });
    for (const result of results) {
      if (result.status !== "success") continue;
      const market = result.result;
      stats.volumeNusd = (BigInt(stats.volumeNusd) + market[5]).toString();
      if (market[7] === 3) stats.graduatedCount += 1;
      else if (market[7] === 2) stats.readyCount += 1;
      else if (market[7] === 1) stats.tradingCount += 1;
    }
  }
  return stats;
}

async function hydrateRpcMarket(token: Address): Promise<PumpMarket> {
  const calls = await publicClient.multicall({
    allowFailure: true,
    contracts: [
      { address: PUMP_FACTORY_ADDRESS, abi: zeroXPumpAbi, functionName: "markets", args: [token] },
      { address: PUMP_FACTORY_ADDRESS, abi: zeroXPumpAbi, functionName: "spotPriceNusdWad", args: [token] },
      { address: PUMP_FACTORY_ADDRESS, abi: zeroXPumpAbi, functionName: "curveProgressBps", args: [token] },
      { address: token, abi: pumpTokenAbi, functionName: "name" },
      { address: token, abi: pumpTokenAbi, functionName: "symbol" },
      { address: token, abi: pumpTokenAbi, functionName: "metadataURI" },
      { address: token, abi: pumpTokenAbi, functionName: "imageURI" },
      { address: token, abi: pumpTokenAbi, functionName: "totalSupply" },
    ],
  });
  if (calls[0].status !== "success") throw new Error("Market not found");

  const market = calls[0].result as RpcMarketState;
  if (!market[0] || market[0] === ZERO_ADDRESS) throw new Error("Market not found");

  const spotPrice = successfulBigInt(calls[1]);
  const progress = Number(successfulBigInt(calls[2]));
  const totalSupply = successfulBigInt(calls[7]);
  const marketCap = (spotPrice * totalSupply) / 1_000_000_000_000_000_000n;
  return {
    ...emptyPumpMarket(getAddress(token)),
    id: getAddress(token),
    tokenAddress: getAddress(token),
    creator: getAddress(market[0]),
    name: successfulString(calls[3], "Unknown token"),
    symbol: successfulString(calls[4], "TOKEN"),
    metadataURI: successfulString(calls[5], ""),
    imageURI: successfulString(calls[6], ""),
    status: statusFromNumber(market[7]),
    reserveNusd: market[2].toString(),
    reserveToken: market[1].toString(),
    virtualNusd: market[4].toString(),
    virtualToken: market[3].toString(),
    priceNusd: formatUnits(spotPrice, 18),
    marketCapNusd: marketCap.toString(),
    progressBps: Number.isFinite(progress) ? Math.min(progress, 10_000) : 0,
    createdAt: safeNumber(market[6]),
    volumeNusd: market[5].toString(),
  };
}

async function getRpcHolders(token: Address, limit: number): Promise<PumpHoldersResponse> {
  const state = await publicClient.multicall({
    allowFailure: true,
    contracts: [
      { address: PUMP_FACTORY_ADDRESS, abi: zeroXPumpAbi, functionName: "markets", args: [token] },
      { address: token, abi: pumpTokenAbi, functionName: "totalSupply" },
      { address: token, abi: pumpTokenAbi, functionName: "balanceOf", args: [PUMP_FACTORY_ADDRESS] },
    ],
  });
  if (state[0].status !== "success") throw new Error("Holder market is unavailable");

  const market = state[0].result as RpcMarketState;
  if (!market[0] || market[0] === ZERO_ADDRESS) throw new Error("Holder market was not found");
  const creator = getAddress(market[0]);
  const totalSupply = state[1].status === "success"
    ? state[1].result
    : await publicClient.readContract({
        address: token,
        abi: pumpTokenAbi,
        functionName: "totalSupply",
      });
  const curveBalance = state[2].status === "success"
    ? state[2].result
    : await publicClient.readContract({
        address: token,
        abi: pumpTokenAbi,
        functionName: "balanceOf",
        args: [PUMP_FACTORY_ADDRESS],
      });
  const latestBlock = await publicClient.getBlockNumber();
  const configuredStartBlock = PUMP_START_BLOCK > 0n;
  const fromBlock = configuredStartBlock
    ? PUMP_START_BLOCK
    : latestBlock > 500_000n
      ? latestBlock - 500_000n
      : 0n;
  const candidates = new Map<string, Address>();
  let candidatesTruncated = false;
  const addCandidate = (account: Address | undefined) => {
    if (!account || account === ZERO_ADDRESS || account.toLowerCase() === PUMP_FACTORY_ADDRESS.toLowerCase()) return;
    const normalized = getAddress(account);
    const key = normalized.toLowerCase();
    if (candidates.has(key)) return;
    if (candidates.size >= MAX_RPC_HOLDER_CANDIDATES) {
      candidatesTruncated = true;
      return;
    }
    candidates.set(key, normalized);
  };
  addCandidate(creator);

  const logRanges: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  for (let chunkFrom = fromBlock; chunkFrom <= latestBlock; chunkFrom += RPC_LOG_BLOCK_CHUNK) {
    const chunkTo = chunkFrom + RPC_LOG_BLOCK_CHUNK - 1n > latestBlock
      ? latestBlock
      : chunkFrom + RPC_LOG_BLOCK_CHUNK - 1n;
    logRanges.push({ fromBlock: chunkFrom, toBlock: chunkTo });
  }
  for (let start = 0; start < logRanges.length; start += RPC_HOLDER_LOG_CONCURRENCY) {
    const pages = await Promise.all(
      logRanges.slice(start, start + RPC_HOLDER_LOG_CONCURRENCY).map((range) =>
        publicClient.getLogs({
          address: token,
          event: TOKEN_TRANSFER_EVENT,
          fromBlock: range.fromBlock,
          toBlock: range.toBlock,
        })),
    );
    for (const logs of pages) {
      for (const log of logs) {
        if ((log.args.value ?? 0n) === 0n) continue;
        addCandidate(log.args.from);
        addCandidate(log.args.to);
      }
    }
  }

  const addresses = [...candidates.values()];
  const balances = new Map<string, bigint>();
  let failedReads = 0;
  for (let start = 0; start < addresses.length; start += 200) {
    const page = addresses.slice(start, start + 200);
    let results = await publicClient.multicall({
      allowFailure: true,
      contracts: page.map((account) => ({
        address: token,
        abi: pumpTokenAbi,
        functionName: "balanceOf" as const,
        args: [account] as const,
      })),
    });
    const retryAccounts = page.filter((_, index) => results[index].status !== "success");
    if (retryAccounts.length) {
      const retries = await publicClient.multicall({
        allowFailure: true,
        contracts: retryAccounts.map((account) => ({
          address: token,
          abi: pumpTokenAbi,
          functionName: "balanceOf" as const,
          args: [account] as const,
        })),
      });
      let retryIndex = 0;
      results = results.map((result) =>
        result.status === "success" ? result : retries[retryIndex++]);
    }
    results.forEach((result, index) => {
      if (result.status === "success") {
        balances.set(page[index].toLowerCase(), result.result as bigint);
      } else {
        failedReads += 1;
      }
    });
  }

  const allHolders = addresses
    .map((account) => ({
      account,
      balance: balances.get(account.toLowerCase()) ?? 0n,
      isCreator: account.toLowerCase() === creator.toLowerCase(),
    }))
    .filter((holder) => holder.balance > 0n)
    .sort((left, right) => {
      if (left.balance !== right.balance) return left.balance > right.balance ? -1 : 1;
      return left.account.toLowerCase().localeCompare(right.account.toLowerCase());
    });
  const creatorBalance = balances.get(creator.toLowerCase()) ?? 0n;
  const holders = mergeCreatorHolder(
    allHolders.slice(0, limit).map((holder) => ({
      account: holder.account,
      balance: holder.balance.toString(),
      isCreator: holder.isCreator,
    })),
    creator,
    creatorBalance.toString(),
  );
  const warnings = [
    !configuredStartBlock ? "Holder scan is limited because the pump start block is not configured." : "",
    candidatesTruncated ? `Holder scan reached the ${MAX_RPC_HOLDER_CANDIDATES.toLocaleString("en-US")} address safety limit.` : "",
    failedReads ? `${failedReads} holder balance${failedReads === 1 ? "" : "s"} could not be verified.` : "",
  ].filter(Boolean);

  return {
    holders,
    creator,
    totalSupply: totalSupply.toString(),
    curveBalance: curveBalance.toString(),
    holderCount: allHolders.length,
    source: "rpc",
    configured: true,
    warning: warnings.length ? warnings.join(" ") : undefined,
  };
}

function normalizeGraphHolder(position: GraphTokenBalance, creator: Address): PumpHolder {
  const account = safeAddress(position.holder);
  return {
    account,
    balance: integerString(position.balance),
    isCreator: account.toLowerCase() === creator.toLowerCase(),
  };
}

function mergeCreatorHolder(
  holders: PumpHolder[],
  creator: Address,
  creatorBalance: string,
): PumpHolder[] {
  const normalizedCreator = creator.toLowerCase();
  if (holders.some((holder) => holder.account.toLowerCase() === normalizedCreator)) {
    return holders.map((holder) =>
      holder.account.toLowerCase() === normalizedCreator
        ? { ...holder, isCreator: true }
        : holder);
  }
  return [
    ...holders,
    { account: creator, balance: integerString(creatorBalance), isCreator: true },
  ];
}

function emptyHoldersResponse(creator: Address, configured: boolean): PumpHoldersResponse {
  return {
    holders: [],
    creator,
    totalSupply: "0",
    curveBalance: "0",
    holderCount: 0,
    source: configured ? "rpc" : "unconfigured",
    configured,
  };
}

async function getRpcTrades(
  token: Address | undefined,
  limit: number,
  skip: number,
): Promise<PumpTrade[]> {
  const latest = await publicClient.getBlockNumber();
  const fromBlock =
    PUMP_START_BLOCK > 0n
      ? PUMP_START_BLOCK
      : latest > RPC_TRADE_LOOKBACK
        ? latest - RPC_TRADE_LOOKBACK
        : 0n;
  const newestFirst: PumpTradeLog[] = [];
  let chunkTo = latest;
  const needed = skip + limit;
  while (chunkTo >= fromBlock && newestFirst.length < needed) {
    const chunkFrom = chunkTo - fromBlock + 1n > RPC_LOG_BLOCK_CHUNK
      ? chunkTo - RPC_LOG_BLOCK_CHUNK + 1n
      : fromBlock;
    const chunk = await fetchPumpTradeLogChunk(token, chunkFrom, chunkTo);
    newestFirst.push(...chunk.reverse());
    if (chunkFrom === fromBlock) break;
    chunkTo = chunkFrom - 1n;
  }
  const selected = newestFirst.slice(skip, skip + limit);
  const blockNumbers = [...new Set(selected.map((log) => log.blockNumber.toString()))];
  const timestamps = new Map<string, number>();
  await Promise.all(
    blockNumbers.map(async (blockNumber) => {
      const block = await publicClient.getBlock({ blockNumber: BigInt(blockNumber) });
      timestamps.set(blockNumber, safeNumber(block.timestamp));
    }),
  );

  return selected.map((log) => {
    const args = log.args;
    const tokenAddress = args.token ? getAddress(args.token) : ZERO_ADDRESS;
    return {
      id: `${log.transactionHash ?? ZERO_HASH}-${log.logIndex ?? 0}`,
      marketAddress: tokenAddress,
      tokenAddress,
      trader: args.trader ? getAddress(args.trader) : ZERO_ADDRESS,
      side: args.isBuy ? "BUY" : "SELL",
      nusdAmount: (args.curveNusdAmount ?? 0n).toString(),
      tokenAmount: (args.tokenAmount ?? 0n).toString(),
      feeNusd: (args.feeNusd ?? 0n).toString(),
      priceNusd: formatUnits(args.spotPriceNusdWad ?? 0n, 18),
      timestamp: timestamps.get(log.blockNumber.toString()) ?? 0,
      blockNumber: safeNumber(log.blockNumber),
      txHash: log.transactionHash ?? ZERO_HASH,
    };
  });
}

async function fetchPumpTradeLogChunk(
  token: Address | undefined,
  fromBlock: bigint,
  toBlock: bigint,
) {
  return publicClient.getLogs({
    address: PUMP_FACTORY_ADDRESS,
    event: TOKEN_TRADED_EVENT,
    args: token ? { token } : undefined,
    fromBlock,
    toBlock,
  });
}

type PumpTradeLog = Awaited<ReturnType<typeof fetchPumpTradeLogChunk>>[number];

function aggregateCandles(trades: PumpTrade[], period: PumpCandlePeriod): PumpCandle[] {
  const buckets = new Map<number, PumpCandle>();
  let previousClose: string | null = null;
  for (const trade of [...trades].reverse()) {
    if (!trade.timestamp) continue;
    const bucket = Math.floor(trade.timestamp / period) * period;
    const existing = buckets.get(bucket);
    if (!existing) {
      const open = previousClose ?? trade.priceNusd;
      buckets.set(bucket, {
        id: `${trade.tokenAddress}-${period}-${bucket}`,
        marketAddress: trade.tokenAddress,
        period,
        bucket,
        timestamp: bucket,
        open,
        high: decimalMax(open, trade.priceNusd),
        low: decimalMin(open, trade.priceNusd),
        close: trade.priceNusd,
        volumeNusd: trade.nusdAmount,
        tradeCount: 1,
      });
      previousClose = trade.priceNusd;
      continue;
    }
    existing.high = decimalMax(existing.high, trade.priceNusd);
    existing.low = decimalMin(existing.low, trade.priceNusd);
    existing.close = trade.priceNusd;
    existing.volumeNusd = (BigInt(existing.volumeNusd) + BigInt(trade.nusdAmount)).toString();
    existing.tradeCount += 1;
    previousClose = trade.priceNusd;
  }
  return [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp);
}

async function graphFetch<T>(
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
  const payload = (await response.json()) as GraphResponse<T>;
  if (payload.errors?.length || !payload.data) {
    throw new Error(payload.errors?.[0]?.message || "Pump subgraph returned no data");
  }
  return payload.data;
}

function normalizeGraphMarket(market: GraphMarket): PumpMarket {
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

function normalizeGraphTrade(trade: GraphTrade): PumpTrade {
  const tokenAddress = safeAddress(trade.market.token || trade.market.id);
  return {
    id: trade.id,
    marketAddress: safeAddress(trade.market.id),
    tokenAddress,
    trader: safeAddress(trade.trader),
    side: trade.side === "SELL" ? "SELL" : "BUY",
    nusdAmount: integerString(trade.nusdAmount),
    tokenAmount: integerString(trade.tokenAmount),
    feeNusd: integerString(trade.feeNusd),
    priceNusd: decimalString(trade.priceNusd),
    timestamp: safeNumber(trade.timestamp),
    blockNumber: safeNumber(trade.blockNumber),
    txHash: /^0x[0-9a-fA-F]{64}$/.test(trade.txHash) ? (trade.txHash as Hex) : ZERO_HASH,
  };
}

function normalizeGraphCandle(
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

function normalizeGraphProtocol(protocol: GraphProtocol): PumpProtocolStats {
  const activeCount = safeNumber(protocol.activeTokenCount);
  const readyCount = safeNumber(protocol.readyTokenCount);
  return {
    marketCount: safeNumber(protocol.tokenCount),
    tradingCount: Math.max(0, activeCount - readyCount),
    readyCount,
    graduatedCount: safeNumber(protocol.graduatedTokenCount),
    tradeCount: safeNumber(protocol.tradeCount),
    volumeNusd: integerString(protocol.totalVolumeNusd),
    feesNusd: integerString(protocol.totalFeesNusd),
  };
}

function emptyProtocolStats(): PumpProtocolStats {
  return {
    marketCount: 0,
    tradingCount: 0,
    readyCount: 0,
    graduatedCount: 0,
    tradeCount: 0,
    volumeNusd: "0",
    feesNusd: "0",
  };
}

function normalizeGraphStatus(value: string): PumpStatus {
  if (value === "GRADUATED") return "GRADUATED";
  if (value === "READY") return "READY";
  return "TRADING";
}

function successfulBigInt(result: { status: string; result?: unknown }): bigint {
  return result.status === "success" && typeof result.result === "bigint" ? result.result : 0n;
}

function successfulString(
  result: { status: string; result?: unknown },
  fallback: string,
): string {
  return result.status === "success" && typeof result.result === "string"
    ? result.result
    : fallback;
}

function safeAddress(value: string): Address {
  try {
    return getAddress(value);
  } catch {
    return ZERO_ADDRESS;
  }
}

function safeNumber(value: string | number | bigint): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function integerString(value: string): string {
  return /^\d+$/.test(value || "") ? value : "0";
}

function decimalString(value: string): string {
  return /^\d+(?:\.\d+)?$/.test(value || "") ? value : "0";
}

function decimalMax(left: string, right: string): string {
  return Number(right) > Number(left) ? right : left;
}

function decimalMin(left: string, right: string): string {
  return Number(right) < Number(left) ? right : left;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function warningMessage(error: unknown, fallback: string): string {
  console.warn("[pump/data]", error);
  return fallback;
}
