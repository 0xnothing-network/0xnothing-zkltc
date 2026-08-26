import { after, NextResponse } from "next/server";
import {
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  parseAbiItem,
  type Address,
} from "viem";
import { deployment } from "@fi/config/deployment";
import { communityLiquidityLockerAbi } from "@fi/lib/abis/locker";
import { tokenMetadataRegistryAbi } from "@fi/lib/abis/metadata";
import { diaOracleAdapterAbi } from "@fi/lib/abis/dia";
import { dexFactoryAbi, dexPoolAbi } from "@fi/lib/abis/dex";
import { erc20Abi } from "@fi/lib/abis/erc20";
import { canonicalOracleMarketForIdentifier, canonicalOracleMarkets } from "@fi/lib/canonicalMarkets";
import type { DataEnvelope, PoolPoint, PoolTokenPoint } from "@fi/lib/data";
import { queryGoldsky, unconfiguredEnvelope } from "@fi/lib/server/goldsky";
import { loadPairTail } from "@fi/lib/server/rpcTail";
import { tokenImageUrl } from "@fi/lib/tokenImage";
import { createBoundedCache } from "@/lib/boundedCache";

type PoolRow = Omit<PoolPoint, "id" | "token0" | "token1" | "totalSupply"> & {
  id: string;
  token0: Omit<PoolTokenPoint, "id"> & { id: string };
  token1: Omit<PoolTokenPoint, "id"> & { id: string };
};
type Result = { pools?: PoolRow[] };

const MAX_RPC_TAIL_BLOCKS = 5_000n;
const MAX_FACTORY_PAIRS = 1_000;
const POOLS_CACHE_TTL_MS = 12_000;
const POOLS_STALE_WHILE_REVALIDATE_MS = 30_000;
const POOLS_CACHE_CONTROL = "public, s-maxage=10, stale-while-revalidate=30";
const RPC_READ_CONCURRENCY = 24;
const DEAD_ADDRESS: Address = "0x000000000000000000000000000000000000dEaD";
const TOKEN_POINT_TTL_MS = 5 * 60_000;
const MAX_TOKEN_POINT_CACHE_ENTRIES = 2_048;
const REGISTRY_IMAGE_TTL_MS = 5 * 60_000;
const MAX_REGISTRY_IMAGE_CACHE_ENTRIES = 2_048;
const lifecycleAbi = [{
  type: "function", name: "status", stateMutability: "view",
  inputs: [{ name: "token", type: "address" }],
  outputs: [{ name: "", type: "uint8" }],
}] as const;
const tokenImageAbi = [{
  type: "function", name: "imageURI", stateMutability: "view",
  inputs: [], outputs: [{ name: "", type: "string" }],
}] as const;
const pairCreatedEvent = parseAbiItem(
  "event PairCreated(address indexed token0, address indexed token1, address pair, bytes32 indexed pairId, bool protectedBootstrap, uint256 pairCount)",
);
const client = createPublicClient({
  transport: http(deployment.chain.rpcUrl, {
    batch: { batchSize: 100, wait: 10 },
    retryCount: 2,
    retryDelay: 300,
    timeout: 15_000,
  }),
});

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

const QUERY = `query Pools {
  _meta { block { number } }
  pools(first: 1000, orderBy: createdAt, orderDirection: desc) {
    id reserve0 reserve1 volumeNusd swapCount protectedBootstrap bootstrapped
    token0 { id symbol name decimals }
    token1 { id symbol name decimals }
  }
}`;

const CANDLES_24H_QUERY = `query Candles24h($since: BigInt!) {
  candles(where: { period: 3600, timestamp_gte: $since }, first: 5000, orderBy: timestamp, orderDirection: asc) {
    pool { id }
    timestamp open close volumeNusd
  }
}`;

type CandleRow = { pool: { id: string }; timestamp: string; open: string; close: string; volumeNusd: string };
type CandlesResult = { candles?: CandleRow[] };

type OraclePoolSnapshot = {
  priceNusd: string;
  updatedAt: number;
};

async function loadCanonicalOracleSnapshots(): Promise<{
  snapshots: Map<string, OraclePoolSnapshot>;
  failed: number;
}> {
  const outcomes = await Promise.all(canonicalOracleMarkets
    .filter((market) => Boolean(market.pool))
    .map(async (market) => {
      if (!market.pool || !market.oracle) return undefined;
      try {
        const [snapshot, fresh] = await Promise.all([
          client.readContract({
            address: market.oracle,
            abi: diaOracleAdapterAbi,
            functionName: "readPriceWad",
          }),
          client.readContract({
            address: market.oracle,
            abi: diaOracleAdapterAbi,
            functionName: "isFresh",
          }),
        ]);
        const [priceWad, updatedAt] = snapshot;
        if (!fresh || priceWad <= 0n || updatedAt <= 0n) return undefined;
        return [market.pool.toLowerCase(), {
          priceNusd: formatUnits(priceWad, 18),
          updatedAt: Number(updatedAt),
        }] as const;
      } catch {
        return undefined;
      }
    }));
  return {
    snapshots: new Map(outcomes.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))),
    failed: outcomes.filter((entry) => !entry).length,
  };
}

function asPoolPoint(row: PoolRow): PoolPoint {
  return {
    ...row,
    id: getAddress(row.id),
    totalSupply: "0",
    token0: { ...row.token0, id: getAddress(row.token0.id) },
    token1: { ...row.token1, id: getAddress(row.token1.id) },
  };
}

function activeAssetPool(pool: PoolPoint, nusd: string): boolean {
  const assets = [
    deployment.contracts.wzkltc,
    deployment.contracts.nbtc,
    deployment.contracts.neth,
  ];
  const token0 = pool.token0.id.toLowerCase();
  const token1 = pool.token1.id.toLowerCase();
  const pairedToken = token0 === nusd ? token1 : token1 === nusd ? token0 : undefined;
  return Boolean(pairedToken && assets.some((asset) => asset?.toLowerCase() === pairedToken));
}

async function visibleDeploymentPools(pools: PoolPoint[]): Promise<{
  pools: PoolPoint[];
  excluded: number;
  communityPoolIds: Set<string>;
}> {
  const nusd = deployment.contracts.nusd?.toLowerCase();
  const pump = deployment.contracts.pump;
  const configuredPairs = new Set([
    deployment.contracts.wzkLtcNusdPair,
    deployment.contracts.nbtcNusdPair,
    deployment.contracts.nethNusdPair,
  ].filter((pair): pair is Address => Boolean(pair)).map((pair) => pair.toLowerCase()));

  const visibleIds = new Set<string>();
  const pumpCandidates = new Map<string, Address>();
  for (const pool of pools) {
    const poolId = pool.id.toLowerCase();
    if (configuredPairs.has(poolId) || (nusd && activeAssetPool(pool, nusd))) {
      visibleIds.add(poolId);
      continue;
    }
    if (!nusd || !pump) continue;
    const token0 = pool.token0.id.toLowerCase();
    const token1 = pool.token1.id.toLowerCase();
    const candidate = token0 === nusd
      ? pool.token1.id
      : token1 === nusd ? pool.token0.id : undefined;
    // The factory only marks pairs created through its bound Pump graduation
    // adapter as protected. Once bootstrapped, that provenance is authoritative
    // even if the supplemental Pump status RPC is temporarily unavailable.
    if (candidate && pool.protectedBootstrap && pool.bootstrapped) {
      visibleIds.add(poolId);
      continue;
    }
    if (candidate) pumpCandidates.set(candidate.toLowerCase(), candidate);
  }

  if (pump) {
    const statuses = await mapWithConcurrency([...pumpCandidates.entries()], RPC_READ_CONCURRENCY, async ([key, token]) => {
      const status = await client.readContract({
        address: pump,
        abi: lifecycleAbi,
        functionName: "status",
        args: [token],
      }).catch(() => 0);
      return [key, Number(status)] as const;
    });
    const graduatedTokens = new Set(statuses.filter(([, status]) => status === 3).map(([key]) => key));
    for (const pool of pools) {
      const token0 = pool.token0.id.toLowerCase();
      const token1 = pool.token1.id.toLowerCase();
      const candidate = token0 === nusd
        ? token1
        : token1 === nusd ? token0 : undefined;
      if (candidate && graduatedTokens.has(candidate)) visibleIds.add(pool.id.toLowerCase());
    }
  }

  // Include bootstrapped community NUSD pairs
  for (const pool of pools) {
    const poolId = pool.id.toLowerCase();
    if (visibleIds.has(poolId)) continue;
    if (!nusd) continue;
    const token0 = pool.token0.id.toLowerCase();
    const token1 = pool.token1.id.toLowerCase();
    const isNusdPair = token0 === nusd || token1 === nusd;
    const hasLiquidityEvidence = BigInt(pool.totalSupply || "0") > 0n
      || BigInt(pool.reserve0 || "0") > 0n
      || BigInt(pool.reserve1 || "0") > 0n;
    if (isNusdPair && hasLiquidityEvidence) {
      visibleIds.add(poolId);
    }
  }

  const visible = pools.filter((pool) => visibleIds.has(pool.id.toLowerCase()));
  // Determine which visible pools are community pairs (not canonical/pump-graduated)
  const canonicalIds = new Set<string>([
    ...configuredPairs,
    ...(nusd ? pools.filter((p) => activeAssetPool(p, nusd)).map((p) => p.id.toLowerCase()) : []),
  ]);
  const communityPoolIds = new Set<string>();
  for (const pool of visible) {
    const poolId = pool.id.toLowerCase();
    if (!canonicalIds.has(poolId) && !(pool.protectedBootstrap && pool.bootstrapped)) {
      communityPoolIds.add(poolId);
    }
  }
  return { pools: visible, excluded: pools.length - visible.length, communityPoolIds };
}

const tokenPointCache = createBoundedCache<PoolTokenPoint>({
  maxEntries: MAX_TOKEN_POINT_CACHE_ENTRIES,
  ttlMs: TOKEN_POINT_TTL_MS,
  maxInFlight: MAX_TOKEN_POINT_CACHE_ENTRIES,
});
const registryImageCache = createBoundedCache<string>({
  maxEntries: MAX_REGISTRY_IMAGE_CACHE_ENTRIES,
  ttlMs: REGISTRY_IMAGE_TTL_MS,
  maxInFlight: MAX_REGISTRY_IMAGE_CACHE_ENTRIES,
});

async function loadTokenPoint(address: Address): Promise<PoolTokenPoint> {
  const fallback = `${address.slice(0, 6)}...${address.slice(-4)}`;
  const [symbol, name, decimals, imageURI] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: "symbol" }).catch(() => fallback),
    client.readContract({ address, abi: erc20Abi, functionName: "name" }).catch(() => "Unknown token"),
    client.readContract({ address, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
    client.readContract({ address, abi: tokenImageAbi, functionName: "imageURI" }).catch(() => ""),
  ]);
  return { id: address, symbol, name, decimals, imageUrl: tokenImageUrl(imageURI) };
}

async function tokenPoint(address: Address): Promise<PoolTokenPoint> {
  return tokenPointCache.load(address.toLowerCase(), () => loadTokenPoint(address));
}

async function enrichPumpTokenImages(pools: PoolPoint[]): Promise<void> {
  const nusd = deployment.contracts.nusd?.toLowerCase();
  if (!nusd) return;
  const candidates = new Map<string, Address>();
  for (const pool of pools) {
    if (!pool.protectedBootstrap) continue;
    for (const token of [pool.token0, pool.token1]) {
      if (token.id.toLowerCase() !== nusd) candidates.set(token.id.toLowerCase(), getAddress(token.id));
    }
  }
  const images = new Map(await mapWithConcurrency(
    [...candidates.entries()],
    RPC_READ_CONCURRENCY,
    async ([key, token]) => [key, (await tokenPoint(token)).imageUrl] as const,
  ));
  for (const pool of pools) {
    const image0 = images.get(pool.token0.id.toLowerCase());
    const image1 = images.get(pool.token1.id.toLowerCase());
    if (image0) pool.token0 = { ...pool.token0, imageUrl: image0 };
    if (image1) pool.token1 = { ...pool.token1, imageUrl: image1 };
  }
}

async function enrichRegistryImages(pools: PoolPoint[]): Promise<void> {
  const registry = deployment.contracts.tokenMetadataRegistry;
  if (!registry) return;
  const nusd = deployment.contracts.nusd?.toLowerCase();
  const candidates = new Map<string, Address>();
  for (const pool of pools) {
    for (const token of [pool.token0, pool.token1]) {
      const tokenId = token.id.toLowerCase();
      if (tokenId === nusd) continue;
      if (token.imageUrl) continue;
      candidates.set(tokenId, getAddress(token.id));
    }
  }
  const images = new Map(await mapWithConcurrency(
    [...candidates.entries()],
    RPC_READ_CONCURRENCY,
    async ([key, token]) => [key, await registryImage(registry, token)] as const,
  ));
  for (const pool of pools) {
    const image0 = images.get(pool.token0.id.toLowerCase());
    const image1 = images.get(pool.token1.id.toLowerCase());
    if (image0 && !pool.token0.imageUrl) pool.token0 = { ...pool.token0, imageUrl: image0 };
    if (image1 && !pool.token1.imageUrl) pool.token1 = { ...pool.token1, imageUrl: image1 };
  }
}

async function registryImage(registry: Address, token: Address): Promise<string> {
  return registryImageCache.load(token.toLowerCase(), async () => {
    const imageURI = await client.readContract({
      address: registry,
      abi: tokenMetadataRegistryAbi,
      functionName: "imageURI",
      args: [token],
    }).catch(() => "");
    return tokenImageUrl(imageURI) ?? "";
  });
}

async function enrichLockBurnBadges(pools: PoolPoint[]): Promise<void> {
  const lpLocker = deployment.contracts.lpLocker;
  const [lockedEntries, burnedEntries] = await Promise.all([
    lpLocker
      ? mapWithConcurrency(
          pools,
          RPC_READ_CONCURRENCY,
          async (pool) => {
            const locked = await client.readContract({
              address: lpLocker,
              abi: communityLiquidityLockerAbi,
              functionName: "activeLockedByToken",
              args: [pool.id],
            }).catch(() => 0n);
            return [pool.id.toLowerCase(), locked.toString()] as const;
          },
        )
      : Promise.resolve([]),
    mapWithConcurrency(
      pools,
      RPC_READ_CONCURRENCY,
      async (pool) => {
        const burned = await client.readContract({
          address: pool.id,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [DEAD_ADDRESS],
        }).catch(() => 0n);
        return [pool.id.toLowerCase(), burned.toString()] as const;
      },
    ),
  ]);

  if (lpLocker) {
    const lockedAmounts = new Map(lockedEntries);
    for (const pool of pools) {
      const locked = lockedAmounts.get(pool.id.toLowerCase());
      if (locked && locked !== "0") pool.lockedLp = locked;
    }
  }
  const burnedAmounts = new Map(burnedEntries);
  for (const pool of pools) {
    const burned = burnedAmounts.get(pool.id.toLowerCase());
    if (burned && burned !== "0") pool.burnedLp = burned;
  }
}

async function loadRpcTail(indexedBlock: number | null): Promise<{
  pools: PoolPoint[];
  fromBlock: bigint;
  toBlock: bigint;
  capped: boolean;
}> {
  const factory = deployment.contracts.dexFactory;
  if (!factory) throw new Error("DEX factory is not configured");
  const latest = await client.getBlockNumber();
  const deploymentBlock = BigInt(deployment.indexer.deploymentBlock || "0");
  const requestedFrom = indexedBlock === null ? deploymentBlock : BigInt(indexedBlock + 1);
  if (requestedFrom > latest) {
    return { pools: [], fromBlock: requestedFrom, toBlock: latest, capped: false };
  }
  const capped = latest - requestedFrom + 1n > MAX_RPC_TAIL_BLOCKS;
  const fromBlock = capped ? latest - MAX_RPC_TAIL_BLOCKS + 1n : requestedFrom;
  const logs = await client.getLogs({
    address: factory,
    event: pairCreatedEvent,
    fromBlock,
    toBlock: latest,
  });

  const pools = await mapWithConcurrency(logs, 12, async (log): Promise<PoolPoint | undefined> => {
    const { pair, protectedBootstrap, token0, token1 } = log.args;
    if (!pair || protectedBootstrap === undefined || !token0 || !token1) return undefined;
    const [reserves, totalSupply, token0Point, token1Point] = await Promise.all([
      client.readContract({ address: pair, abi: dexPoolAbi, functionName: "getReserves" }),
      client.readContract({ address: pair, abi: dexPoolAbi, functionName: "totalSupply" }),
      tokenPoint(token0),
      tokenPoint(token1),
    ]);
    return {
      id: pair,
      reserve0: reserves[0].toString(),
      reserve1: reserves[1].toString(),
      totalSupply: totalSupply.toString(),
      volumeNusd: "0",
      swapCount: "0",
      protectedBootstrap,
      bootstrapped: !protectedBootstrap || totalSupply > 0n,
      token0: token0Point,
      token1: token1Point,
    };
  });
  return { pools: pools.filter((pool): pool is PoolPoint => Boolean(pool)), fromBlock, toBlock: latest, capped };
}

async function refreshPools(pools: PoolPoint[]): Promise<{ failedPools: number; totalPools: number }> {
  const outcomes = await mapWithConcurrency(pools, RPC_READ_CONCURRENCY, async (pool) => {
    const [reserves, totalSupply] = await Promise.allSettled([
      client.readContract({ address: pool.id, abi: dexPoolAbi, functionName: "getReserves" }),
      client.readContract({ address: pool.id, abi: dexPoolAbi, functionName: "totalSupply" }),
    ]);
    if (reserves.status === "fulfilled") {
      pool.reserve0 = reserves.value[0].toString();
      pool.reserve1 = reserves.value[1].toString();
    }
    if (totalSupply.status === "fulfilled") {
      pool.totalSupply = totalSupply.value.toString();
      pool.bootstrapped = totalSupply.value > 0n;
    }
    return reserves.status === "rejected" || totalSupply.status === "rejected";
  });
  return {
    failedPools: outcomes.filter(Boolean).length,
    totalPools: pools.length,
  };
}

async function loadFactoryPools(): Promise<PoolPoint[]> {
  const factory = deployment.contracts.dexFactory;
  const pump = deployment.contracts.pump;
  const nusd = deployment.contracts.nusd;
  if (!factory || !pump || !nusd) throw new Error("Factory discovery is not configured");
  const length = await client.readContract({ address: factory, abi: dexFactoryAbi, functionName: "allPairsLength" });
  if (length > BigInt(MAX_FACTORY_PAIRS)) throw new Error("Factory pair count exceeds the discovery limit");
  const pairIndexes = Array.from({ length: Number(length) }, (_, index) => index);
  const pairs = await mapWithConcurrency(pairIndexes, RPC_READ_CONCURRENCY, (index) => client.readContract({
    address: factory,
    abi: dexFactoryAbi,
    functionName: "allPairs",
    args: [BigInt(index)],
  }));
  const rows = await mapWithConcurrency(pairs, 12, async (pair): Promise<PoolPoint | undefined> => {
    const [token0, token1, reserves, totalSupply] = await Promise.all([
      client.readContract({ address: pair, abi: dexPoolAbi, functionName: "token0" }),
      client.readContract({ address: pair, abi: dexPoolAbi, functionName: "token1" }),
      client.readContract({ address: pair, abi: dexPoolAbi, functionName: "getReserves" }),
      client.readContract({ address: pair, abi: dexPoolAbi, functionName: "totalSupply" }),
    ]);
    const candidatePumpToken = token0.toLowerCase() === nusd.toLowerCase()
      ? token1
      : token1.toLowerCase() === nusd.toLowerCase() ? token0 : undefined;
    const lifecycle = candidatePumpToken ? await client.readContract({
      address: pump,
      abi: lifecycleAbi,
      functionName: "status",
      args: [candidatePumpToken],
    }).catch(() => 0) : 0;
    const protectedBootstrap = lifecycle >= 1 && lifecycle <= 3;
    const [token0Point, token1Point] = await Promise.all([tokenPoint(token0), tokenPoint(token1)]);
    return {
      id: pair,
      reserve0: reserves[0].toString(),
      reserve1: reserves[1].toString(),
      totalSupply: totalSupply.toString(),
      volumeNusd: "0",
      swapCount: "0",
      protectedBootstrap,
      bootstrapped: !protectedBootstrap || totalSupply > 0n,
      token0: token0Point,
      token1: token1Point,
    };
  });
  return rows.filter((pool): pool is PoolPoint => Boolean(pool));
}

async function loadPoolsEnvelope(): Promise<DataEnvelope<PoolPoint[]>> {
  try {
    let envelope: DataEnvelope<PoolPoint[]>;
    try {
      envelope = await queryGoldsky<Result, PoolPoint[]>(
        QUERY,
        {},
        (data) => (data.pools || []).map(asPoolPoint),
        [],
      );
    } catch (error) {
      envelope = unconfiguredEnvelope<PoolPoint[]>(
        [],
        `Goldsky unavailable: ${error instanceof Error ? error.message : "query failed"}`,
      );
    }

    if (envelope.meta.source === "unconfigured") {
      try {
        envelope.data = await loadFactoryPools();
      } catch (error) {
        envelope.warning = `${envelope.warning ? `${envelope.warning} ` : ""}Factory discovery unavailable: ${error instanceof Error ? error.message : "request failed"}`;
      }
    } else {
      // Ensure reserves/supply are current even for indexed pools
      const refresh = await refreshPools(envelope.data);
      if (refresh.failedPools > 0) {
        envelope.warning = `${envelope.warning ? `${envelope.warning} ` : ""}Live liquidity refresh failed for ${refresh.failedPools} of ${refresh.totalPools} pools; indexed values were preserved.`;
      }
    }

    try {
      const tail = await loadRpcTail(envelope.meta.indexedBlock);
      const merged = new Map(envelope.data.map((pool) => [pool.id.toLowerCase(), pool]));
      if (tail.capped) {
        try {
          const discovered = await loadFactoryPools();
          for (const pool of discovered) {
            const key = pool.id.toLowerCase();
            if (!merged.has(key)) merged.set(key, pool);
          }
        } catch (error) {
          envelope.warning = `${envelope.warning ? `${envelope.warning} ` : ""}Factory discovery unavailable while the RPC tail is capped: ${error instanceof Error ? error.message : "request failed"}`;
        }
      }
      for (const pool of tail.pools) merged.set(pool.id.toLowerCase(), pool);
      envelope.data = [...merged.values()];
      envelope.meta.rpcTail = {
        status: tail.capped ? "capped" : "merged",
        fromBlock: Number(tail.fromBlock),
        toBlock: Number(tail.toBlock),
        merged: true,
        eventCount: tail.pools.length,
      };
    } catch (error) {
      envelope.meta.rpcTail.status = "unavailable";
      envelope.warning = `${envelope.warning ? `${envelope.warning} ` : ""}RPC tail unavailable: ${error instanceof Error ? error.message : "request failed"}`;
    }

    const visible = await visibleDeploymentPools(envelope.data);
    envelope.data = visible.pools;
    // Mark community pairs
    for (const pool of envelope.data) {
      if (visible.communityPoolIds.has(pool.id.toLowerCase())) {
        pool.communityPair = true;
      }
    }
    const since24h = Math.floor(Date.now() / 1000) - 86_400;
    const [oracleState, candleEnv] = await Promise.all([
      loadCanonicalOracleSnapshots(),
      queryGoldsky<CandlesResult, CandleRow[]>(
        CANDLES_24H_QUERY,
        { since: since24h.toString() },
        (data) => data.candles ?? [],
        [],
      ).catch(() => undefined),
      (async () => {
        await enrichPumpTokenImages(envelope.data).catch(() => { /* fallback logos remain available */ });
        await enrichRegistryImages(envelope.data).catch(() => { /* registry images are additive */ });
      })(),
      enrichLockBurnBadges(envelope.data).catch(() => { /* lock/burn badges are additive */ }),
    ]);

    // Canonical markets are priced by DIA. Reserves remain the source of TVL.
    if (oracleState.failed > 0) {
      envelope.warning = `${envelope.warning ? `${envelope.warning} ` : ""}DIA price is unavailable for ${oracleState.failed} canonical market${oracleState.failed === 1 ? "" : "s"}.`;
    }

    // Enrich with market price, TVL, and 24-hour metrics.
    const nusd = deployment.contracts.nusd?.toLowerCase();
    envelope.data = envelope.data.map((pool) => {
      const canonicalMarket = canonicalOracleMarketForIdentifier(pool.id);
      const oracleSnapshot = oracleState.snapshots.get(pool.id.toLowerCase());
      const isToken0Nusd = nusd && pool.token0.id.toLowerCase() === nusd;
      const isToken1Nusd = nusd && pool.token1.id.toLowerCase() === nusd;
      if (!isToken0Nusd && !isToken1Nusd) return {
        ...pool,
        priceSource: canonicalMarket ? "oracle" as const : "dex" as const,
        priceNusd: oracleSnapshot?.priceNusd,
        oracleUpdatedAt: oracleSnapshot?.updatedAt,
      };
      try {
        const nusdReserveRaw = isToken0Nusd ? pool.reserve0 : pool.reserve1;
        const tokenReserveRaw = isToken0Nusd ? pool.reserve1 : pool.reserve0;
        const nusdDec = isToken0Nusd ? pool.token0.decimals : pool.token1.decimals;
        const tokenDec = isToken0Nusd ? pool.token1.decimals : pool.token0.decimals;
        const nusdR = Number(formatUnits(BigInt(nusdReserveRaw), nusdDec));
        const tokenR = Number(formatUnits(BigInt(tokenReserveRaw), tokenDec));
        const priceNusd = tokenR > 0 ? nusdR / tokenR : undefined;
        const tvlNusd = nusdR * 2;
        return {
          ...pool,
          priceNusd: canonicalMarket
            ? oracleSnapshot?.priceNusd
            : priceNusd !== undefined ? priceNusd.toString() : undefined,
          priceSource: canonicalMarket ? "oracle" as const : "dex" as const,
          oracleUpdatedAt: canonicalMarket ? oracleSnapshot?.updatedAt : undefined,
          tvlNusd: tvlNusd.toString(),
        };
      } catch { return pool; }
    });

    // 24h metrics from Goldsky 1h candles
    if (candleEnv) {
      const byPool = new Map<string, { volNusd: number; firstOpen?: number; lastClose?: number }>();
      for (const c of candleEnv.data) {
        const key = c.pool.id.toLowerCase();
        const existing = byPool.get(key) ?? { volNusd: 0 };
        existing.volNusd += Number(formatUnits(BigInt(c.volumeNusd), 18));
        if (existing.firstOpen === undefined) existing.firstOpen = Number(c.open);
        existing.lastClose = Number(c.close);
        byPool.set(key, existing);
      }
      envelope.data = envelope.data.map((pool) => {
        const stats = byPool.get(pool.id.toLowerCase());
        // Candle prices are already the non-NUSD token price in NUSD. No swaps in the
        // rolling window means the pool price did not move, so report 0% instead of N/A.
        if (!stats) return { ...pool, priceChange24h: pool.priceNusd === undefined ? undefined : 0 };
        const volume24hNusd = stats.volNusd.toString();
        const priceChange24h = stats.firstOpen !== undefined
          && Number.isFinite(stats.firstOpen)
          && stats.firstOpen > 0
          && stats.lastClose !== undefined
          && Number.isFinite(stats.lastClose)
          ? ((stats.lastClose - stats.firstOpen) / stats.firstOpen) * 100
          : 0;
        return { ...pool, volume24hNusd, priceChange24h };
      });
    }

    // RPC-tail volume for newly graduated / unindexed pools (up to MAX_TAIL_BLOCKS blocks)
    try {
      const poolsNeedingTailVol = envelope.data.filter(
        (p) => p.volume24hNusd === undefined && BigInt(p.totalSupply || "0") > 0n,
      );
      if (poolsNeedingTailVol.length > 0 && nusd) {
        let incompleteTailVolume = false;
        await mapWithConcurrency(poolsNeedingTailVol, 6, async (pool) => {
          try {
            const tail = await loadPairTail(pool.id, envelope.meta.indexedBlock);
            if (tail.capped) {
              incompleteTailVolume = true;
              return;
            }
            const isToken0Nusd = pool.token0.id.toLowerCase() === nusd;
            const isToken1Nusd = pool.token1.id.toLowerCase() === nusd;
            if (!isToken0Nusd && !isToken1Nusd) return;
            let vol = 0;
            for (const ev of tail.events) {
              if (ev.kind !== "swap" || ev.timestamp < since24h) continue;
              const nusdFlow = isToken0Nusd
                ? ev.amount0In + ev.amount0Out
                : ev.amount1In + ev.amount1Out;
              vol += Number(formatUnits(nusdFlow, 18));
            }
            pool.volume24hNusd = vol.toString();
          } catch { /* non-fatal */ }
        });
        if (incompleteTailVolume) {
          envelope.warning = `${envelope.warning ? `${envelope.warning} ` : ""}24h volume is unavailable while the RPC tail is capped.`;
        }
      }
    } catch { /* non-fatal */ }

    return envelope;
  } catch (error) {
    throw error;
  }
}

// A single-entry cache retained indefinitely: freshness is derived from the entry
// age instead of a ttl, so the last successful snapshot can still answer a request
// after the stale-while-revalidate window when a refresh fails outright.
const POOLS_CACHE_KEY = "pools";
const poolsCache = createBoundedCache<DataEnvelope<PoolPoint[]>>({ maxEntries: 1 });

function loadPoolsOnce(): Promise<DataEnvelope<PoolPoint[]>> {
  return poolsCache.refresh(POOLS_CACHE_KEY, loadPoolsEnvelope);
}

function poolsResponse(envelope: DataEnvelope<PoolPoint[]>, cacheStatus: "HIT" | "MISS" | "COALESCED" | "STALE") {
  return NextResponse.json(envelope, {
    headers: {
      "Cache-Control": POOLS_CACHE_CONTROL,
      "X-0xFi-Cache": cacheStatus,
    },
  });
}

export async function GET() {
  const cached = poolsCache.entry(POOLS_CACHE_KEY);
  if (cached && cached.ageMs < POOLS_CACHE_TTL_MS) {
    return poolsResponse(cached.value, "HIT");
  }

  if (cached && cached.ageMs < POOLS_CACHE_TTL_MS + POOLS_STALE_WHILE_REVALIDATE_MS) {
    // Keep the serverless invocation alive until the shared background refresh settles.
    after(() => loadPoolsOnce().catch(() => { /* retain the last successful response during the stale window */ }));
    return poolsResponse(cached.value, "STALE");
  }

  const joinedExistingRequest = Boolean(poolsCache.pending(POOLS_CACHE_KEY));

  try {
    const envelope = await loadPoolsOnce();
    return poolsResponse(envelope, joinedExistingRequest ? "COALESCED" : "MISS");
  } catch (error) {
    const stale = poolsCache.entry(POOLS_CACHE_KEY);
    if (stale) {
      return poolsResponse({
        ...stale.value,
        warning: `${stale.value.warning ? `${stale.value.warning} ` : ""}Live refresh failed; serving the last successful market snapshot.`,
      }, "STALE");
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Indexer query failed" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
