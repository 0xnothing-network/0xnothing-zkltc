import "server-only";

import { formatUnits, getAddress, type Address, type Hex } from "viem";
import { publicClient } from "@/lib/contract";
import { PUMP_FACTORY_ADDRESS, ZERO_ADDRESS } from "@/features/pump/config";
import { pumpTokenAbi, zeroXPumpAbi } from "@/features/pump/abis";
import {
  emptyPumpMarket,
  statusFromNumber,
  type PumpMarket,
  type PumpMarketSort,
  type PumpProtocolStats,
} from "@/features/pump/types";
import { MAX_MARKETS, RPC_MARKET_HYDRATE_CONCURRENCY } from "./constants";
import { emptyProtocolStats } from "./graph";
import {
  mapWithConcurrency,
  safeNumber,
  successfulBigInt,
  successfulString,
} from "./values";

/**
 * Market and protocol reads straight from the factory, used whenever the
 * subgraph is unavailable and to overlay live state on an indexed market.
 */

export type RpcMarketState = readonly [
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

export async function getRpcMarkets(
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
  const markets = await mapWithConcurrency(page, RPC_MARKET_HYDRATE_CONCURRENCY, (token) =>
    hydrateRpcMarket(token).catch(() => null),
  );
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

export async function getRpcProtocolStats(): Promise<PumpProtocolStats> {
  const tokens = (await publicClient.readContract({
    address: PUMP_FACTORY_ADDRESS,
    abi: zeroXPumpAbi,
    functionName: "getAllTokens",
  })) as readonly Address[];
  const stats = emptyProtocolStats();
  stats.marketCount = tokens.length;

  for (let start = 0; start < tokens.length; start += 100) {
    const page = tokens.slice(start, start + 100);
    let results = await publicClient.multicall({
      allowFailure: true,
      contracts: page.map((token) => ({
        address: PUMP_FACTORY_ADDRESS,
        abi: zeroXPumpAbi,
        functionName: "markets" as const,
        args: [token] as const,
      })),
    });
    const retryTokens = page.filter((_, index) => results[index].status !== "success");
    if (retryTokens.length) {
      const retries = await publicClient.multicall({
        allowFailure: true,
        contracts: retryTokens.map((token) => ({
          address: PUMP_FACTORY_ADDRESS,
          abi: zeroXPumpAbi,
          functionName: "markets" as const,
          args: [token] as const,
        })),
      });
      let retryIndex = 0;
      results = results.map((result) =>
        result.status === "success" ? result : retries[retryIndex++]);
    }
    if (results.some((result) => result.status !== "success")) {
      throw new Error("Live RPC market totals are incomplete.");
    }
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

export async function hydrateRpcMarket(token: Address): Promise<PumpMarket> {
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
    dex: getAddress(market[8]),
    dexPairId: market[9],
    pool: getAddress(market[10]),
  };
}
