import type { Address } from "viem";
import { erc20Abi, lendingPoolAbi } from "../../abis";
import type { WalletToken } from "../../config/assets";
import { CONTRACTS } from "../../config/contracts";
import { usdValueWad } from "../lib/format";
import { persistentStore } from "../platform/storage";
import { STORAGE_KEYS } from "../platform/storageKeys";
import { withNamedLock } from "../platform/locks";
import { latestBlock } from "../rpc/blockTicker";
import { activeNetwork, publicClient } from "../rpc/client";
import { loadPrices, type PriceMap } from "./prices";

/**
 * Everything the HOME screen needs, using batched reads for balances and
 * prices. Supplied NUSD is counted in the total — it is the
 * user's money, it just sits in the lending pool instead of the wallet, and it
 * is not double counted because supplying moves the balance out.
 */
export interface AssetRow {
  token: WalletToken;
  balance: bigint;
  priceWad: bigint;
  valueWad: bigint;
  stale: boolean;
}

export interface Portfolio {
  rows: AssetRow[];
  /** False when any balance/price leg was unavailable; do not snapshot it. */
  complete: boolean;
  /** Wallet holdings plus supplied NUSD. */
  totalWad: bigint;
  suppliedNusd: bigint;
  blockNumber: bigint;
  at: number;
  prices: PriceMap;
}

const PORTFOLIO_TTL_MS = 750;
const PORTFOLIO_CACHE_LIMIT = 8;

interface CachedPortfolio {
  at: number;
  value: Portfolio;
}

type ReadResult =
  | { status: "success"; result: unknown }
  | { status: "failure"; error: unknown };

async function readDirect(client: typeof publicClient, contract: unknown): Promise<ReadResult> {
  try {
    const result = await client.readContract(contract as never);
    return { status: "success", result };
  } catch (error) {
    return { status: "failure", error };
  }
}

const portfolioCache = new Map<string, CachedPortfolio>();
const portfolioLoads = new Map<string, Promise<Portfolio>>();

function portfolioKey(address: Address, tokens: readonly WalletToken[]): string {
  return JSON.stringify([
    activeNetwork.id,
    activeNetwork.rpcUrl,
    address.toLowerCase(),
    tokens.map((token) => [
      token.id,
      token.address?.toLowerCase() ?? null,
      token.symbol,
      token.name,
      token.decimals,
      token.priceSource,
      token.builtin,
      token.pinned ?? false,
      token.logo ?? null,
    ]),
  ]);
}

function rememberPortfolio(key: string, value: Portfolio): void {
  portfolioCache.delete(key);
  portfolioCache.set(key, { at: Date.now(), value });
  if (portfolioCache.size <= PORTFOLIO_CACHE_LIMIT) return;
  const oldest = portfolioCache.keys().next().value;
  if (oldest !== undefined) portfolioCache.delete(oldest);
}

export function loadPortfolio(
  address: Address,
  tokens: readonly WalletToken[],
): Promise<Portfolio> {
  const key = portfolioKey(address, tokens);
  const cached = portfolioCache.get(key);
  const age = cached === undefined ? Number.POSITIVE_INFINITY : Date.now() - cached.at;
  if (cached !== undefined && age >= 0 && age < PORTFOLIO_TTL_MS) {
    return Promise.resolve(cached.value);
  }
  const active = portfolioLoads.get(key);
  if (active !== undefined) return active;

  const request = fetchPortfolio(address, tokens).then((value) => {
    rememberPortfolio(key, value);
    return value;
  });
  portfolioLoads.set(key, request);
  void request.then(
    () => {
      if (portfolioLoads.get(key) === request) portfolioLoads.delete(key);
    },
    () => {
      if (portfolioLoads.get(key) === request) portfolioLoads.delete(key);
    },
  );
  return request;
}

async function fetchPortfolio(
  address: Address,
  tokens: readonly WalletToken[],
): Promise<Portfolio> {
  const erc20Tokens = tokens.filter((token) => token.address);
  const client = publicClient;
  const network = activeNetwork;
  const knownBlock = latestBlock();
  const includeLending = network.builtin;
  const balanceContracts = [
    ...erc20Tokens.map(
      (token) =>
        ({
          address: token.address!,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        }) as const,
    ),
    ...(includeLending
      ? [{
          address: CONTRACTS.lendingPool,
          abi: lendingPoolAbi,
          functionName: "supplyBalance",
          args: [address],
        } as const]
      : []),
  ];

  const balancesPromise: Promise<readonly ReadResult[]> = balanceContracts.length === 0
    ? Promise.resolve([])
    : network.builtin
      ? client.multicall({ allowFailure: true, contracts: balanceContracts }) as Promise<readonly ReadResult[]>
      : Promise.all(balanceContracts.map((contract) => readDirect(client, contract)));
  const [nativeBalance, blockNumber, balances, prices] = await Promise.all([
    client.getBalance({ address }),
    knownBlock > 0n
      ? Promise.resolve(knownBlock)
      : client.getBlockNumber({ cacheTime: 0 }),
    balancesPromise,
    loadPrices(tokens, network, client),
  ]);

  const failedBalance = balances.find((entry) => entry.status === "failure");
  if (failedBalance !== undefined) throw failedBalance.error;

  const suppliedCall = includeLending ? balances[balances.length - 1] : undefined;
  const suppliedNusd =
    suppliedCall?.status === "success" ? (suppliedCall.result as bigint) : 0n;

  const rows: AssetRow[] = [];
  const balanceIndex = new Map(erc20Tokens.map((token, index) => [token.id, index]));
  for (const token of tokens) {
    const price = prices.get(token.id);
    const priceWad = price?.priceWad ?? 0n;
    let balance = 0n;
    if (!token.address) {
      balance = nativeBalance;
    } else {
      const index = balanceIndex.get(token.id);
      const call = index === undefined ? undefined : balances[index];
      balance = call?.status === "success" ? (call.result as bigint) : 0n;
    }
    rows.push({
      token,
      balance,
      priceWad,
      valueWad: usdValueWad(balance, token.decimals, priceWad),
      stale: price?.stale ?? true,
    });
  }

  const holdingsWad = rows.reduce((sum, row) => sum + row.valueWad, 0n);
  return {
    rows,
    complete: rows.every((row) => !row.stale),
    totalWad: holdingsWad + suppliedNusd,
    suppliedNusd,
    blockNumber,
    at: Date.now(),
    prices,
  };
}

/** Rows worth listing: pinned built-ins, anything with a balance, all imports. */
export function visibleRows(rows: readonly AssetRow[]): AssetRow[] {
  return rows.filter((row) => row.token.pinned || !row.token.builtin || row.balance > 0n);
}

/* ------------------------------------------------------------- 24h change */

interface Snapshot {
  at: number;
  /** Decimal string — JSON has no BigInt. */
  totalWad: string;
}

type SnapshotBook = Record<string, Snapshot[]>;

const SNAPSHOT_INTERVAL_MS = 15 * 60_000;
const SNAPSHOT_KEEP = 200;
const DAY_MS = 24 * 60 * 60_000;
/** How far from exactly 24h ago a sample may be and still be used. */
const MATCH_TOLERANCE_MS = 6 * 60 * 60_000;
const SNAPSHOT_LOCK = `portfolio:${STORAGE_KEYS.snapshots}`;

/**
 * These local samples are the fallback for a portfolio that market candles do
 * not cover. They also keep 24h useful on custom networks without an indexer.
 */
export async function recordSnapshot(address: Address, totalWad: bigint): Promise<void> {
  await withNamedLock(SNAPSHOT_LOCK, async () => {
    const book = (await persistentStore.get<SnapshotBook>(STORAGE_KEYS.snapshots)) ?? {};
    const key = address.toLowerCase();
    const series = book[key] ?? [];
    const last = series[series.length - 1];
    const now = Date.now();
    if (last && now - last.at < SNAPSHOT_INTERVAL_MS) return;
    const next = [...series, { at: now, totalWad: totalWad.toString() }].slice(-SNAPSHOT_KEEP);
    await persistentStore.set(STORAGE_KEYS.snapshots, { ...book, [key]: next });
  });
}

/** Fractional change (0.0125 = +1.25%), or null when there is no baseline yet. */
export async function change24h(address: Address, totalWad: bigint): Promise<number | null> {
  const book = await persistentStore.get<SnapshotBook>(STORAGE_KEYS.snapshots);
  const series = book?.[address.toLowerCase()];
  if (!series || series.length === 0) return null;

  const target = Date.now() - DAY_MS;
  let best: Snapshot | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const sample of series) {
    const gap = Math.abs(sample.at - target);
    if (gap < bestGap) {
      best = sample;
      bestGap = gap;
    }
  }
  if (!best || bestGap > MATCH_TOLERANCE_MS) return null;

  const before = BigInt(best.totalWad);
  if (before === 0n) return null;
  const deltaBps = ((totalWad - before) * 10_000n) / before;
  return Number(deltaBps) / 10_000;
}
