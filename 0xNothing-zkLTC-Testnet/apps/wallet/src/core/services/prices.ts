import type { Address } from "viem";
import { dexFactoryAbi, dexPoolAbi, diaOracleAdapterAbi, zeroXPumpAbi } from "../../abis";
import type { WalletToken } from "../../config/assets";
import type { WalletNetwork } from "../../config/networks";
import { CONTRACTS } from "../../config/contracts";
import { WAD } from "../lib/format";
import { activeNetwork, publicClient } from "../rpc/client";
import { nusdOracleAddress } from "./nusdOracle";

type ReadClient = typeof publicClient;

/**
 * USD pricing, using exactly the sources the web app uses — no price API.
 *
 *  zkLTC / WzkLTC : DIA LTC/USD, read from the adapter NUSD itself is bound to
 *  NUSD           : 1.00 — it is the unit of account, and the mint that creates
 *                   it settles at that same DIA price, so a dollar of NUSD is a
 *                   dollar of collateral at the feed rather than at the pool
 *  everything else: spot from the token's 0xPump curve when it is still
 *  trading/ready, otherwise from its NUSD pool reserves
 *
 * A pool price is a *spot* price and can be manipulated in a thin pool; it is
 * used for display only, never to size a trade. The known-mispriced
 * WzkLTC/NUSD pool is precisely why zkLTC is priced off the feed instead.
 */
export interface TokenPrice {
  priceWad: bigint;
  source: WalletToken["priceSource"];
  /** True when the selected price leg is stale or could not be read completely. */
  stale: boolean;
}

export type PriceMap = ReadonlyMap<string, TokenPrice>;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const PRICE_TTL_MS = 1_500;
const PAIR_MISS_TTL_MS = 10_000;
const CACHE_LIMIT = 8;

interface CachedPrices {
  at: number;
  value: PriceMap;
}

const priceCache = new Map<string, CachedPrices>();
const priceLoads = new Map<string, Promise<PriceMap>>();
const pairCache = new Map<string, Address>();
const pairRetryAfter = new Map<string, number>();
const pairLoads = new Map<string, Promise<Address | null>>();
const token0Cache = new Map<string, Address>();
const token0Loads = new Map<string, Promise<Address | null>>();

function tokenKey(tokens: readonly WalletToken[], network: WalletNetwork): string {
  return [network.id, network.rpcUrl, ...tokens
    .map(
      (token) =>
        `${token.id}:${token.address?.toLowerCase() ?? "native"}:${token.decimals}:${token.priceSource}`,
    )
    .sort()].join("|");
}

function rememberPrices(key: string, value: PriceMap): void {
  priceCache.delete(key);
  priceCache.set(key, { at: Date.now(), value });
  if (priceCache.size <= CACHE_LIMIT) return;
  const oldest = priceCache.keys().next().value;
  if (oldest !== undefined) priceCache.delete(oldest);
}

function pairFor(token: Address, network: WalletNetwork, client: ReadClient): Promise<Address | null> {
  const key = `${network.id}:${token.toLowerCase()}`;
  const cached = pairCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const active = pairLoads.get(key);
  if (active !== undefined) return active;
  if (Date.now() < (pairRetryAfter.get(key) ?? 0)) return Promise.resolve(null);

  const request: Promise<Address | null> = client
    .readContract({
      address: CONTRACTS.dexFactory,
      abi: dexFactoryAbi,
      functionName: "getPair",
      args: [token, CONTRACTS.nusd],
    })
    .then((pair) => {
      if (pair === ZERO_ADDRESS) {
        pairRetryAfter.set(key, Date.now() + PAIR_MISS_TTL_MS);
        return null;
      }
      pairRetryAfter.delete(key);
      pairCache.set(key, pair);
      return pair;
    })
    .catch(() => {
      pairRetryAfter.set(key, Date.now() + PRICE_TTL_MS);
      return null;
    });
  pairLoads.set(key, request);
  void request.then(() => {
    if (pairLoads.get(key) === request) pairLoads.delete(key);
  });
  return request;
}

function token0For(pair: Address, network: WalletNetwork, client: ReadClient): Promise<Address | null> {
  const key = `${network.id}:${pair.toLowerCase()}`;
  const cached = token0Cache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const active = token0Loads.get(key);
  if (active !== undefined) return active;

  const request: Promise<Address | null> = client
    .readContract({ address: pair, abi: dexPoolAbi, functionName: "token0" })
    .then((token0) => {
      if (token0 === ZERO_ADDRESS) return null;
      token0Cache.set(key, token0);
      return token0;
    })
    .catch(() => null);
  token0Loads.set(key, request);
  void request.then(() => {
    if (token0Loads.get(key) === request) token0Loads.delete(key);
  });
  return request;
}

export function loadPrices(
  tokens: readonly WalletToken[],
  network: WalletNetwork = activeNetwork,
  client: ReadClient = publicClient,
): Promise<PriceMap> {
  const key = tokenKey(tokens, network);
  const cached = priceCache.get(key);
  const age = cached === undefined ? Number.POSITIVE_INFINITY : Date.now() - cached.at;
  if (cached !== undefined && age >= 0 && age < PRICE_TTL_MS) return Promise.resolve(cached.value);
  const active = priceLoads.get(key);
  if (active !== undefined) return active;

  const request = fetchPrices(tokens, network, client).then((value) => {
    rememberPrices(key, value);
    return value;
  });
  priceLoads.set(key, request);
  void request.then(
    () => {
      if (priceLoads.get(key) === request) priceLoads.delete(key);
    },
    () => {
      if (priceLoads.get(key) === request) priceLoads.delete(key);
    },
  );
  return request;
}

async function fetchPrices(
  tokens: readonly WalletToken[],
  network: WalletNetwork,
  client: ReadClient,
): Promise<PriceMap> {
  const prices = new Map<string, TokenPrice>();
  if (!network.builtin) {
    // Custom chains have no 0xFi oracle or Pump factory addresses. Balances are
    // still useful, but showing an invented USD price would be misleading.
    tokens.forEach((token) => {
      prices.set(token.id, { priceWad: 0n, source: "none", stale: false });
    });
    return prices;
  }
  const poolTokens = tokens.filter((token) => token.priceSource === "pool" && token.address);
  const needsOracle = tokens.some((token) => token.priceSource === "oracle");

  // Start immutable metadata and live market reads together. On the first load
  // the adapter lookup may add a second RPC wave; later loads use its cache.
  const adapterPromise = needsOracle ? nusdOracleAddress(network, client) : Promise.resolve(null);
  const pairsPromise = Promise.all(poolTokens.map((token) => pairFor(token.address!, network, client)));
  const pumpPromise = poolTokens.length > 0
    ? client.multicall({
        allowFailure: true,
        contracts: poolTokens.flatMap(
          (token) =>
            [
              {
                address: CONTRACTS.pumpFactory,
                abi: zeroXPumpAbi,
                functionName: "status",
                args: [token.address!],
              },
              {
                address: CONTRACTS.pumpFactory,
                abi: zeroXPumpAbi,
                functionName: "spotPriceNusdWad",
                args: [token.address!],
              },
            ] as const,
        ),
      })
    : Promise.resolve(null);
  const adapter = await adapterPromise;

  const [oracleCalls, pairAddresses, pumpCalls] = await Promise.all([
    adapter !== null
      ? client.multicall({
          allowFailure: true,
          contracts: [
            {
              address: adapter,
              abi: diaOracleAdapterAbi,
              functionName: "readPriceWad",
            },
            { address: adapter, abi: diaOracleAdapterAbi, functionName: "isFresh" },
          ] as const,
        })
      : null,
    pairsPromise,
    pumpPromise,
  ]);

  let ltcPriceWad = 0n;
  let ltcStale = true;
  if (oracleCalls) {
    const [priceCall, freshCall] = oracleCalls;
    const hasPrice = priceCall.status === "success" && priceCall.result[0] > 0n;
    if (hasPrice) ltcPriceWad = priceCall.result[0];
    ltcStale = !(hasPrice && freshCall.status === "success" && freshCall.result);
  }

  for (const token of tokens) {
    if (token.priceSource === "usd") {
      prices.set(token.id, { priceWad: WAD, source: "usd", stale: false });
    } else if (token.priceSource === "oracle") {
      prices.set(token.id, { priceWad: ltcPriceWad, source: "oracle", stale: ltcStale });
    } else if (token.priceSource === "none") {
      prices.set(token.id, { priceWad: 0n, source: "none", stale: false });
    }
  }

  const pairs = poolTokens.map((token, index) => ({ token, pair: pairAddresses[index] ?? null }));

  const withPair = pairs.filter((entry): entry is { token: WalletToken; pair: Address } =>
    entry.pair !== null,
  );
  if (withPair.length > 0) {
    const [token0s, reserves] = await Promise.all([
      Promise.all(withPair.map((entry) => token0For(entry.pair, network, client))),
      client.multicall({
        allowFailure: true,
        contracts: withPair.map(
          (entry) =>
            ({ address: entry.pair, abi: dexPoolAbi, functionName: "getReserves" }) as const,
        ),
      }),
    ]);

    withPair.forEach((entry, index) => {
      const token0 = token0s[index]?.toLowerCase();
      const reservesCall = reserves[index];
      if (token0 === undefined || reservesCall?.status !== "success") return;
      if (token0 !== entry.token.address!.toLowerCase() && token0 !== CONTRACTS.nusd.toLowerCase()) {
        return;
      }
      const [reserve0, reserve1] = reservesCall.result as readonly [bigint, bigint, number];
      const tokenIsZero = token0 === entry.token.address!.toLowerCase();
      const reserveToken = tokenIsZero ? reserve0 : reserve1;
      const reserveNusd = tokenIsZero ? reserve1 : reserve0;
      if (reserveToken === 0n || reserveNusd === 0n) return;
      // NUSD is 18-decimal, so scaling by the token's own decimals is enough.
      const scale = 10n ** BigInt(entry.token.decimals);
      prices.set(entry.token.id, {
        priceWad: (reserveNusd * scale) / reserveToken,
        source: "pool",
        stale: false,
      });
    });
  }

  // Before graduation, the bonding curve is the canonical market. Its spot
  // price is already WAD-scaled against NUSD, so it can replace a stale or
  // incidental AMM quote without any decimal conversion. Graduated markets
  // continue using the DEX reserves above.
  poolTokens.forEach((token, index) => {
    const statusCall = pumpCalls?.[index * 2];
    const spotCall = pumpCalls?.[index * 2 + 1];
    if (statusCall?.status !== "success" || spotCall?.status !== "success") return;
    const lifecycle = Number(statusCall.result);
    const spotPrice = spotCall.result as bigint;
    if ((lifecycle === 1 || lifecycle === 2) && spotPrice > 0n) {
      prices.set(token.id, {
        priceWad: spotPrice,
        source: "pool",
        stale: false,
      });
    }
  });

  for (const token of tokens) {
    if (!prices.has(token.id)) {
      // A missing pair or failed metadata read is not a real zero-dollar
      // quote. Mark it stale so callers do not record a false portfolio loss.
      prices.set(token.id, { priceWad: 0n, source: "none", stale: true });
    }
  }
  return prices;
}
