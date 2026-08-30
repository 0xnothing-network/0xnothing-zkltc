import { getAddress, isAddress, type Address } from "viem";
import {
  dexFactoryAbi,
  dexPoolAbi,
  erc20Abi,
  tokenImageAbi,
  zeroXPumpAbi,
} from "../../abis";
import {
  customToken,
  NATIVE_TOKEN,
  NUSD_TOKEN,
  type WalletToken,
} from "../../config/assets";
import { CONTRACTS } from "../../config/contracts";
import {
  FI_SUBGRAPH_URL,
  PUBLIC_APP_URL,
  PUMP_SUBGRAPH_URL,
} from "../../config/dapps";
import type { WalletNetwork } from "../../config/networks";
import { weightedPortfolioChange24h } from "../lib/portfolioChange";
import { activeNetwork, publicClient } from "../rpc/client";
import type { Portfolio } from "./portfolio";

export { weightedPortfolioChange24h } from "../lib/portfolioChange";

export type SwapMarketSource = "0xPump" | "0xFi";

export interface SwapCatalogEntry {
  token: WalletToken;
  source: SwapMarketSource;
  /** Lower values are shown first. Active Pump curves outrank AMM pools. */
  priority: 1 | 2;
}

export interface SwapCatalog {
  entries: SwapCatalogEntry[];
  /** Fractional change keyed by token address; 0.05 means +5%. */
  changes24h: Readonly<Record<string, number>>;
  /** Discovery or 24h index coverage is incomplete and should be disclosed. */
  degraded: boolean;
}

const CATALOG_TTL_MS = 15_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 6_000;
const MAX_PUMP_TOKENS = 200;
const MAX_DEX_PAIRS = 300;
const MAX_CANDLE_TOKENS = 12;

let catalogCache: { key: string; at: number; value: SwapCatalog } | null = null;
let catalogLoad: { key: string; promise: Promise<SwapCatalog> } | null = null;

function catalogKey(network: WalletNetwork): string {
  return `${network.id}:${network.rpcUrl}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanText(value: unknown, fallback: string, max = 64): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max && !/[\u0000-\u001f\u007f]/u.test(trimmed)
    ? trimmed
    : fallback;
}

function safeLogo(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length <= 2_048
    ? value.trim() || undefined
    : undefined;
}

async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("Market response is too large");
  }
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new Error("Market response is too large");
    return new TextDecoder().decode(buffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Market response is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function boundedJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Market API ${response.status}`);
    const text = await boundedText(response);
    return JSON.parse(text) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

async function boundedGraph(
  url: string,
  query: string,
  variables: Readonly<Record<string, unknown>> = {},
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Market index ${response.status}`);
    const text = await boundedText(response);
    const envelope = record(JSON.parse(text));
    const errors = envelope?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const first = record(errors[0]);
      throw new Error(cleanText(first?.message, "Market index error", 160));
    }
    const data = record(envelope?.data);
    if (!data) throw new Error("Market index returned no data");
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function candidateToken(input: {
  address: string;
  symbol: unknown;
  name: unknown;
  decimals?: unknown;
  logo?: unknown;
}): WalletToken | null {
  if (!isAddress(input.address)) return null;
  const address = getAddress(input.address);
  const fallback = `${address.slice(0, 6)}…${address.slice(-4)}`;
  const symbol = cleanText(input.symbol, fallback, 16);
  const name = cleanText(input.name, symbol, 80);
  const decimals = Number(input.decimals ?? 18);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  return customToken({ address, symbol, name, decimals, logo: safeLogo(input.logo) });
}

function hasLiquidity(pool: Record<string, unknown>): boolean {
  try {
    return BigInt(String(pool.totalSupply ?? "0")) > 0n
      || (BigInt(String(pool.reserve0 ?? "0")) > 0n && BigInt(String(pool.reserve1 ?? "0")) > 0n);
  } catch {
    return false;
  }
}

function parsePumpCatalog(payload: unknown): SwapCatalogEntry[] {
  const markets = record(payload)?.markets;
  if (!Array.isArray(markets)) throw new Error("Invalid Pump catalog");
  const entries: SwapCatalogEntry[] = [];
  for (const raw of markets.slice(0, MAX_PUMP_TOKENS)) {
    const market = record(raw);
    if (!market || typeof market.tokenAddress !== "string") continue;
    const token = candidateToken({
      address: market.tokenAddress,
      symbol: market.symbol,
      name: market.name,
      logo: market.imageURI,
    });
    if (!token) continue;
    const active = market.status === "TRADING" || market.status === "READY";
    entries.push({ token, source: "0xPump", priority: active ? 1 : 2 });
  }
  return entries;
}

function parseFiCatalog(payload: unknown): {
  entries: SwapCatalogEntry[];
  changes24h: Record<string, number>;
} {
  const pools = record(payload)?.data;
  if (!Array.isArray(pools)) throw new Error("Invalid 0xFi catalog");
  const entries: SwapCatalogEntry[] = [];
  const changes24h: Record<string, number> = {};
  for (const raw of pools.slice(0, MAX_DEX_PAIRS)) {
    const pool = record(raw);
    if (!pool || !hasLiquidity(pool)) continue;
    const tokens = [record(pool.token0), record(pool.token1)];
    for (const meta of tokens) {
      if (!meta || typeof meta.id !== "string") continue;
      const token = candidateToken({
        address: meta.id,
        symbol: meta.symbol,
        name: meta.name,
        decimals: meta.decimals,
        logo: meta.imageUrl,
      });
      if (token) entries.push({ token, source: "0xFi", priority: 2 });
    }
    const changePercent = Number(pool.priceChange24h);
    if (!Number.isFinite(changePercent) || changePercent <= -100 || changePercent > 1_000_000) continue;
    const nonNusd = tokens.find((meta) =>
      typeof meta?.id === "string" && meta.id.toLowerCase() !== CONTRACTS.nusd.toLowerCase()
    );
    if (typeof nonNusd?.id === "string" && isAddress(nonNusd.id)) {
      changes24h[nonNusd.id.toLowerCase()] = changePercent / 100;
    }
  }
  return { entries, changes24h };
}

async function pumpCatalogFromGraph(): Promise<SwapCatalogEntry[]> {
  const data = await boundedGraph(
    PUMP_SUBGRAPH_URL,
    `query WalletPumpCatalog($first: Int!) {
      markets(first: $first, orderBy: volumeNusd, orderDirection: desc) {
        token name symbol imageURI status
      }
    }`,
    { first: MAX_PUMP_TOKENS },
  );
  const markets = Array.isArray(data.markets) ? data.markets : [];
  return parsePumpCatalog({
    markets: markets.map((raw) => {
      const market = record(raw);
      return market ? { ...market, tokenAddress: market.token } : raw;
    }),
  });
}

async function fiCatalogFromGraph(): Promise<{
  entries: SwapCatalogEntry[];
  changes24h: Record<string, number>;
}> {
  const since = Math.floor(Date.now() / 1_000) - 24 * 60 * 60;
  const data = await boundedGraph(
    FI_SUBGRAPH_URL,
    `query WalletFiCatalog($since: BigInt!) {
      pools(first: 300, orderBy: createdAt, orderDirection: desc) {
        id reserve0 reserve1 protectedBootstrap bootstrapped
        token0 { id symbol name decimals }
        token1 { id symbol name decimals }
      }
      candles(
        where: { period: 3600, timestamp_gte: $since }
        first: 1000
        orderBy: timestamp
        orderDirection: asc
      ) {
        pool { id }
        timestamp open close
      }
    }`,
    { since: since.toString() },
  );
  const pools = Array.isArray(data.pools) ? data.pools.map(record).filter(Boolean) : [];
  const candles = Array.isArray(data.candles) ? data.candles.map(record).filter(Boolean) : [];
  const completeCandles = candles.length < 1_000;
  const stats = new Map<string, { firstOpen: number; lastClose: number }>();
  if (completeCandles) {
    for (const candle of candles) {
      if (!candle) continue;
      const pool = record(candle.pool);
      const id = typeof pool?.id === "string" ? pool.id.toLowerCase() : "";
      const open = Number(candle.open);
      const close = Number(candle.close);
      if (!id || !Number.isFinite(open) || open <= 0 || !Number.isFinite(close) || close < 0) {
        continue;
      }
      const current = stats.get(id);
      stats.set(id, { firstOpen: current?.firstOpen ?? open, lastClose: close });
    }
  }
  return parseFiCatalog({
    data: pools.map((pool) => {
      const id = typeof pool?.id === "string" ? pool.id.toLowerCase() : "";
      const point = stats.get(id);
      const priceChange24h = !completeCandles
        ? undefined
        : point
        ? ((point.lastClose - point.firstOpen) / point.firstOpen) * 100
        : 0;
      return { ...pool, totalSupply: "0", priceChange24h };
    }),
  });
}

async function hydrateTokens(addresses: readonly Address[], client: typeof publicClient): Promise<Map<string, WalletToken>> {
  const unique = [...new Map(addresses.map((address) => [address.toLowerCase(), address])).values()];
  if (unique.length === 0) return new Map();
  const calls = await client.multicall({
    allowFailure: true,
    contracts: unique.flatMap((address) => [
      { address, abi: erc20Abi, functionName: "symbol" },
      { address, abi: erc20Abi, functionName: "name" },
      { address, abi: erc20Abi, functionName: "decimals" },
      { address, abi: tokenImageAbi, functionName: "imageURI" },
    ] as const),
  });
  const result = new Map<string, WalletToken>();
  unique.forEach((address, index) => {
    const offset = index * 4;
    const symbolCall = calls[offset];
    const nameCall = calls[offset + 1];
    const decimalsCall = calls[offset + 2];
    const logoCall = calls[offset + 3];
    const symbol = symbolCall?.status === "success" ? symbolCall.result : undefined;
    const name = nameCall?.status === "success" ? nameCall.result : undefined;
    const decimals = decimalsCall?.status === "success" ? decimalsCall.result : undefined;
    const logo = logoCall?.status === "success" ? logoCall.result : undefined;
    const token = candidateToken({ address, symbol, name, decimals, logo });
    if (token) result.set(address.toLowerCase(), token);
  });
  return result;
}

async function pumpCatalogOnChain(client: typeof publicClient): Promise<SwapCatalogEntry[]> {
  const raw = await client.readContract({
    address: CONTRACTS.pumpFactory,
    abi: zeroXPumpAbi,
    functionName: "getAllTokens",
  });
  const addresses = (Array.isArray(raw) ? raw : [])
    .filter((value): value is Address => typeof value === "string" && isAddress(value))
    .slice(-MAX_PUMP_TOKENS)
    .reverse()
    .map((value) => getAddress(value));
  const [metadata, statuses] = await Promise.all([
    hydrateTokens(addresses, client),
    addresses.length === 0
      ? Promise.resolve([])
      : client.multicall({
          allowFailure: true,
          contracts: addresses.map((address) => ({
            address: CONTRACTS.pumpFactory,
            abi: zeroXPumpAbi,
            functionName: "status",
            args: [address],
          }) as const),
        }),
  ]);
  const entries: SwapCatalogEntry[] = [];
  addresses.forEach((address, index) => {
    const statusCall = statuses[index];
    const status = statusCall?.status === "success" ? Number(statusCall.result) : 0;
    const token = metadata.get(address.toLowerCase());
    if (token && status >= 1 && status <= 3) {
      entries.push({ token, source: "0xPump", priority: status <= 2 ? 1 : 2 });
    }
  });
  return entries;
}

async function fiCatalogOnChain(client: typeof publicClient): Promise<SwapCatalogEntry[]> {
  const total = await client.readContract({
    address: CONTRACTS.dexFactory,
    abi: dexFactoryAbi,
    functionName: "allPairsLength",
  });
  const count = total > BigInt(MAX_DEX_PAIRS) ? MAX_DEX_PAIRS : Number(total);
  const start = total - BigInt(count);
  const indexes = Array.from({ length: count }, (_, index) => start + BigInt(index));
  const pairCalls = count === 0 ? [] : await client.multicall({
    allowFailure: true,
    contracts: indexes.map((index) => ({
      address: CONTRACTS.dexFactory,
      abi: dexFactoryAbi,
      functionName: "allPairs",
      args: [index],
    }) as const),
  });
  const pairs = pairCalls
    .flatMap((call) => call.status === "success" ? [call.result] : [])
    .filter((value): value is Address => typeof value === "string" && isAddress(value))
    .map((value) => getAddress(value));
  if (pairs.length === 0) return [];
  const state = await client.multicall({
    allowFailure: true,
    contracts: pairs.flatMap((pair) => [
      { address: pair, abi: dexPoolAbi, functionName: "token0" },
      { address: pair, abi: dexPoolAbi, functionName: "token1" },
      { address: pair, abi: dexPoolAbi, functionName: "getReserves" },
      { address: pair, abi: dexPoolAbi, functionName: "totalSupply" },
    ] as const),
  });
  const addresses: Address[] = [];
  pairs.forEach((_pair, index) => {
    const offset = index * 4;
    const token0 = state[offset];
    const token1 = state[offset + 1];
    const reserves = state[offset + 2];
    const supply = state[offset + 3];
    const reserveTuple = reserves?.status === "success"
      ? reserves.result as readonly [bigint, bigint, number]
      : undefined;
    const liquid = supply?.status === "success" && (supply.result as bigint) > 0n
      || Boolean(reserveTuple && reserveTuple[0] > 0n && reserveTuple[1] > 0n);
    if (!liquid) return;
    if (token0?.status === "success" && typeof token0.result === "string" && isAddress(token0.result)) {
      addresses.push(getAddress(token0.result));
    }
    if (token1?.status === "success" && typeof token1.result === "string" && isAddress(token1.result)) {
      addresses.push(getAddress(token1.result));
    }
  });
  const metadata = await hydrateTokens(addresses, client);
  return [...metadata.values()].map((token) => ({ token, source: "0xFi", priority: 2 }));
}

function mergeEntries(groups: readonly SwapCatalogEntry[][]): SwapCatalogEntry[] {
  const merged = new Map<string, SwapCatalogEntry>();
  for (const group of groups) {
    for (const entry of group) {
      const key = entry.token.address?.toLowerCase();
      if (!key) continue;
      const current = merged.get(key);
      if (
        !current
        || entry.priority < current.priority
        || (entry.priority === current.priority && entry.source === "0xFi")
      ) merged.set(key, entry);
    }
  }
  return [...merged.values()].sort((left, right) =>
    left.priority - right.priority
    || left.token.symbol.localeCompare(right.token.symbol)
    || left.token.id.localeCompare(right.token.id)
  );
}

async function fetchCatalog(network: WalletNetwork): Promise<SwapCatalog> {
  if (!network.builtin) return { entries: [], changes24h: {}, degraded: false };
  const client = publicClient;
  const [pumpApi, fiApi] = await Promise.allSettled([
    boundedJson(`${PUBLIC_APP_URL}/api/pump/markets?limit=${MAX_PUMP_TOKENS}&sort=VOLUME`),
    boundedJson(`${PUBLIC_APP_URL}/0xFi/api/data/pools`),
  ]);
  let pumpEntries: SwapCatalogEntry[] = [];
  let fiEntries: SwapCatalogEntry[] = [];
  let changes24h: Record<string, number> = {};
  let pumpIndexed = false;
  let fiIndexed = false;
  let fiChangesIndexed = false;
  let usedOnChain = false;

  if (pumpApi.status === "fulfilled") {
    try {
      pumpEntries = parsePumpCatalog(pumpApi.value);
      pumpIndexed = true;
    } catch { /* try the public index directly */ }
  }
  if (pumpEntries.length === 0) {
    try {
      pumpEntries = await pumpCatalogFromGraph();
      pumpIndexed = true;
    } catch { /* fall through to bounded on-chain discovery */ }
  }
  if (pumpEntries.length === 0) {
    pumpEntries = await pumpCatalogOnChain(client).catch(() => []);
    usedOnChain ||= pumpEntries.length > 0;
  }

  if (fiApi.status === "fulfilled") {
    try {
      const parsed = parseFiCatalog(fiApi.value);
      fiEntries = parsed.entries;
      changes24h = parsed.changes24h;
      fiIndexed = true;
      fiChangesIndexed = Object.keys(changes24h).length > 0;
    } catch { /* try the public index directly */ }
  }
  if (fiEntries.length === 0 || !fiChangesIndexed) {
    try {
      const parsed = await fiCatalogFromGraph();
      fiEntries = mergeEntries([fiEntries, parsed.entries]);
      changes24h = { ...parsed.changes24h, ...changes24h };
      fiIndexed = true;
      fiChangesIndexed = Object.keys(changes24h).length > 0;
    } catch { /* fall through to bounded on-chain discovery */ }
  }
  if (fiEntries.length === 0) {
    fiEntries = await fiCatalogOnChain(client).catch(() => []);
    usedOnChain ||= fiEntries.length > 0;
  }

  const degraded = usedOnChain || !pumpIndexed || !fiIndexed || !fiChangesIndexed;
  return { entries: mergeEntries([pumpEntries, fiEntries]), changes24h, degraded };
}

export function loadSwapCatalog(network: WalletNetwork = activeNetwork): Promise<SwapCatalog> {
  const key = catalogKey(network);
  const cached = catalogCache;
  if (cached?.key === key && Date.now() - cached.at < CATALOG_TTL_MS) {
    return Promise.resolve(cached.value);
  }
  if (catalogLoad?.key === key) return catalogLoad.promise;
  const promise = fetchCatalog(network).then((value) => {
    catalogCache = { key, at: Date.now(), value };
    return value;
  }).finally(() => {
    if (catalogLoad?.promise === promise) catalogLoad = null;
  });
  catalogLoad = { key, promise };
  return promise;
}

async function pumpCandleChange(address: Address): Promise<number | null> {
  let raw: unknown[] = [];
  try {
    const payload = record(await boundedJson(
      `${PUBLIC_APP_URL}/api/pump/candles?token=${address}&period=3600&limit=25`,
    ));
    if (Array.isArray(payload?.candles)) raw = payload.candles;
  } catch { /* try Goldsky directly below */ }
  if (raw.length < 2) {
    try {
      const data = await boundedGraph(
        PUMP_SUBGRAPH_URL,
        `query WalletPumpCandles($market: Bytes!) {
          candles(
            first: 25
            where: { market: $market, period: 60 }
            orderBy: timestamp
            orderDirection: desc
          ) { timestamp open close }
        }`,
        { market: address.toLowerCase() },
      );
      if (Array.isArray(data.candles)) raw = data.candles;
    } catch { /* the local snapshot remains the final fallback */ }
  }
  if (raw.length < 2) return null;
  const candles = raw.map(record).filter((entry): entry is Record<string, unknown> => entry !== null)
    .sort((left, right) => Number(left.timestamp ?? 0) - Number(right.timestamp ?? 0));
  const target = Date.now() / 1_000 - 24 * 60 * 60;
  const baseline = candles.reduce<{ candle: Record<string, unknown>; gap: number } | null>(
    (best, candle) => {
      const rawTimestamp = Number(candle.timestamp ?? 0);
      const timestamp = rawTimestamp > 10_000_000_000 ? rawTimestamp / 1_000 : rawTimestamp;
      const gap = Math.abs(timestamp - target);
      return Number.isFinite(gap) && (best === null || gap < best.gap)
        ? { candle, gap }
        : best;
    },
    null,
  );
  // A sparse token with no candle near 24h has no honest 24h baseline.
  if (!baseline || baseline.gap > 6 * 60 * 60) return null;
  const open = Number(baseline.candle.open);
  const close = Number(candles[candles.length - 1]?.close);
  if (!Number.isFinite(open) || open <= 0 || !Number.isFinite(close) || close < 0) return null;
  const change = (close - open) / open;
  return change > -1 && change < 10_000 ? change : null;
}

export async function loadPortfolioMarketChange24h(
  portfolio: Portfolio,
  network: WalletNetwork = activeNetwork,
): Promise<number | null> {
  if (!network.builtin) return null;
  const catalog = await loadSwapCatalog(network);
  const changes: Record<string, number> = { ...catalog.changes24h };
  // A live bonding curve is the wallet's execution/price source, so an early
  // protected AMM pool must not override its candles before graduation.
  for (const entry of catalog.entries) {
    if (entry.source === "0xPump" && entry.priority === 1 && entry.token.address) {
      delete changes[entry.token.address.toLowerCase()];
    }
  }
  changes[NUSD_TOKEN.id] = 0;
  const wrappedChange = changes[CONTRACTS.wzkltc.toLowerCase()];
  if (wrappedChange !== undefined) changes[NATIVE_TOKEN.id] = wrappedChange;

  const pumpAddresses = portfolio.rows
    .filter((row) => row.valueWad > 0n && row.token.address && changes[row.token.id] === undefined)
    .map((row) => row.token.address!)
    .filter((address) => catalog.entries.some((entry) =>
      entry.source === "0xPump" && entry.token.address?.toLowerCase() === address.toLowerCase()
    ))
    .slice(0, MAX_CANDLE_TOKENS);
  const candleChanges = await Promise.all(pumpAddresses.map(async (address) => [
    address.toLowerCase(),
    await pumpCandleChange(address).catch(() => null),
  ] as const));
  for (const [address, change] of candleChanges) {
    if (change !== null) changes[address] = change;
  }
  return weightedPortfolioChange24h(portfolio.rows, portfolio.suppliedNusd, changes);
}
