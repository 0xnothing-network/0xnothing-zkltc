import { NextRequest, NextResponse } from "next/server";
import { formatUnits, getAddress, isAddress, type Address } from "viem";
import { assetForPool, canonicalPairs, deployedPairForSlug, pairSlug, parsePairSlug } from "@fi/config/assets";
import type { ActivityPoint, DataEnvelope } from "@fi/lib/data";
import { queryGoldsky, unconfiguredEnvelope } from "@fi/lib/server/goldsky";
import { isFactoryPair, loadPairTail, pairForTokens, pairTokenMetadata } from "@fi/lib/server/rpcTail";
import { deployment } from "@fi/config/deployment";

const QUERY = `
  query Activity($pool: Bytes!, $first: Int!) {
    _meta { block { number } }
    swaps(where: { pool: $pool }, first: $first, orderBy: timestamp, orderDirection: desc) {
      id timestamp sender amount0In amount1In amount0Out amount1Out txHash logIndex
    }
    liquidityEvents(where: { pool: $pool }, first: $first, orderBy: timestamp, orderDirection: desc) {
      id timestamp action sender amount0 amount1 txHash logIndex
    }
  }
`;

type SwapRow = { id: string; timestamp: string; sender: string; amount0In: string; amount1In: string; amount0Out: string; amount1Out: string; txHash: string; logIndex: string };
type LiquidityRow = { id: string; timestamp: string; action: "MINT" | "BURN"; sender: string; amount0: string; amount1: string; txHash: string; logIndex: string };
type Result = { swaps?: SwapRow[]; liquidityEvents?: LiquidityRow[] };

const CACHE_TTL_MS = 12_000;
const STALE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 128;
const CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30",
};

type ActivityEnvelope = DataEnvelope<ActivityPoint[]>;
type CacheEntry = { envelope: ActivityEnvelope; updatedAt: number };

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ActivityEnvelope>>();

function amount(value: string | bigint, decimals: number, prefix = ""): string {
  try { return `${prefix}${formatUnits(typeof value === "bigint" ? value : BigInt(value), decimals)}`; }
  catch { return `${prefix}${value}`; }
}

function remember(pair: string, envelope: ActivityEnvelope): void {
  if (!cache.has(pair) && cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(pair, { envelope, updatedAt: Date.now() });
}

async function loadActivity(pair: string, dynamicPool?: Address): Promise<ActivityEnvelope> {
  const symbols = dynamicPool ? undefined : parsePairSlug(pair)!;
  const pool = dynamicPool ?? deployedPairForSlug(pair) ?? await pairForTokens(
    deployment.contracts.dexFactory,
    symbols ? assetForPool(symbols[0]) : undefined,
    symbols ? assetForPool(symbols[1]) : undefined,
  );
  if (!pool) return unconfiguredEnvelope([], "Pair address is not configured for indexed activity.");

  const metadata = await pairTokenMetadata(pool).catch(() => undefined);
  const decimals0 = metadata?.decimals0 ?? 18;
  const decimals1 = metadata?.decimals1 ?? 18;
  let envelope: ActivityEnvelope;
  try {
    envelope = await queryGoldsky<Result, ActivityPoint[]>(
      QUERY,
      { pool: pool.toLowerCase(), first: 50 },
      (data) => [
        ...(data.swaps || []).map((event): ActivityPoint => ({
          id: event.id, timestamp: Number(event.timestamp), type: "swap", pair,
          amount0: event.amount0In !== "0" ? amount(event.amount0In, decimals0, "-") : amount(event.amount0Out, decimals0, "+"),
          amount1: event.amount1In !== "0" ? amount(event.amount1In, decimals1, "-") : amount(event.amount1Out, decimals1, "+"),
          account: event.sender, transactionHash: event.txHash, logIndex: Number(event.logIndex),
        })),
        ...(data.liquidityEvents || []).map((event): ActivityPoint => ({
          id: event.id, timestamp: Number(event.timestamp), type: event.action === "MINT" ? "add" : "remove", pair,
          amount0: amount(event.amount0, decimals0), amount1: amount(event.amount1, decimals1), account: event.sender,
          transactionHash: event.txHash, logIndex: Number(event.logIndex),
        })),
      ].sort((a, b) => b.timestamp - a.timestamp).slice(0, 50),
      [],
    );
  } catch (error) {
    envelope = unconfiguredEnvelope<ActivityPoint[]>([], `Goldsky unavailable: ${error instanceof Error ? error.message : "query failed"}`);
  }

  try {
    const tail = await loadPairTail(pool, envelope.meta.indexedBlock);
    const tailActivity = tail.events.flatMap((event): ActivityPoint[] => {
      if (event.kind === "sync") return [];
      if (event.kind === "swap") return [{
        id: `${event.transactionHash}-${event.logIndex}`, timestamp: event.timestamp, type: "swap", pair,
        amount0: event.amount0In > 0n ? amount(event.amount0In, decimals0, "-") : amount(event.amount0Out, decimals0, "+"),
        amount1: event.amount1In > 0n ? amount(event.amount1In, decimals1, "-") : amount(event.amount1Out, decimals1, "+"),
        account: event.sender, transactionHash: event.transactionHash, logIndex: event.logIndex,
      }];
      return [{
        id: `${event.transactionHash}-${event.logIndex}`, timestamp: event.timestamp,
        type: event.kind === "mint" ? "add" : "remove", pair,
        amount0: amount(event.amount0, decimals0), amount1: amount(event.amount1, decimals1),
        account: event.sender, transactionHash: event.transactionHash, logIndex: event.logIndex,
      }];
    });
    const merged = new Map([...envelope.data, ...tailActivity].map((event) => [`${event.transactionHash}-${event.logIndex}`, event]));
    envelope.data = [...merged.values()].sort((a, b) => b.timestamp - a.timestamp || b.logIndex - a.logIndex).slice(0, 50);
    envelope.meta.rpcTail = { status: tail.capped ? "capped" : "merged", fromBlock: Number(tail.fromBlock), toBlock: Number(tail.toBlock), merged: true, eventCount: tailActivity.length };
  } catch (error) {
    envelope.meta.rpcTail.status = "unavailable";
    envelope.warning = `${envelope.warning ? `${envelope.warning} ` : ""}RPC tail unavailable: ${error instanceof Error ? error.message : "request failed"}`;
  }
  return envelope;
}

export async function GET(request: NextRequest) {
  const pair = request.nextUrl.searchParams.get("pair")?.toLowerCase() || "";
  const validPairs = canonicalPairs.map(([a, b]) => pairSlug(a, b));
  const dynamicPool = isAddress(pair) ? getAddress(pair) : undefined;
  if (!dynamicPool && !validPairs.includes(pair)) {
    return NextResponse.json({ error: "Unsupported pair." }, { status: 400 });
  }

  try {
    if (dynamicPool && !(await isFactoryPair(deployment.contracts.dexFactory, dynamicPool))) {
      return NextResponse.json({ error: "Unsupported pair." }, { status: 400 });
    }

    const cached = cache.get(pair);
    if (cached && Date.now() - cached.updatedAt <= CACHE_TTL_MS) {
      return NextResponse.json(cached.envelope, { headers: CACHE_HEADERS });
    }

    let pending = inFlight.get(pair);
    if (!pending) {
      pending = loadActivity(pair, dynamicPool);
      inFlight.set(pair, pending);
    }
    try {
      const envelope = await pending;
      remember(pair, envelope);
      return NextResponse.json(envelope, { headers: CACHE_HEADERS });
    } catch (error) {
      if (cached && Date.now() - cached.updatedAt <= STALE_TTL_MS) {
        const message = error instanceof Error ? error.message : "refresh failed";
        return NextResponse.json({
          ...cached.envelope,
          warning: `${cached.envelope.warning ? `${cached.envelope.warning} ` : ""}Activity refresh failed; showing cached data: ${message}`,
        }, { headers: CACHE_HEADERS });
      }
      throw error;
    } finally {
      if (inFlight.get(pair) === pending) inFlight.delete(pair);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Indexer query failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
