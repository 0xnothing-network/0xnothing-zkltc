export type RwaAddress = `0x${string}`;
export interface RwaMarketConfig {
  chainId: number;
  market: RwaAddress;
  asset: RwaAddress;
  settlement: RwaAddress;
  assetSymbol: string;
  settlementSymbol: string;
  assetDecimals: number;
  settlementDecimals: number;
  name: string;
  issuer: string;
  documentationUrl: string;
  sourceUrls: string[];
}

function address(value: unknown): value is RwaAddress {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value);
}
function https(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }
  catch { return false; }
}

export function validateMarkets(value: unknown): readonly RwaMarketConfig[] {
  if (!Array.isArray(value)) throw new Error("Invalid RWA catalog");
  const seen = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid RWA market");
    const row = entry as Record<string, unknown>;
    if (!Number.isSafeInteger(row.chainId) || Number(row.chainId) <= 0
      || !address(row.market) || !address(row.asset) || !address(row.settlement)
      || new Set([row.market, row.asset, row.settlement].map((s) => s.toLowerCase())).size !== 3
      || ![row.assetDecimals, row.settlementDecimals].every((n) => Number.isInteger(n) && Number(n) >= 0 && Number(n) <= 18)
      || ![row.name, row.issuer, row.assetSymbol, row.settlementSymbol].every((s) => typeof s === "string" && s.trim().length > 0 && s.length <= 120)
      || !https(row.documentationUrl) || !Array.isArray(row.sourceUrls)
      || row.sourceUrls.length !== 4 || !row.sourceUrls.every(https)) throw new Error("Invalid RWA market configuration");
    const key = `${row.chainId}:${row.market.toLowerCase()}`;
    if (seen.has(key)) throw new Error("Duplicate RWA market");
    seen.add(key);
    return Object.freeze({ ...row, sourceUrls: [...row.sourceUrls] }) as unknown as RwaMarketConfig;
  });
}

export function parseRwaAmount(text: string, decimals: number): bigint | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || text.length > 100
    || !/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole = "", fraction = ""] = text.split(".");
  if (fraction.length > decimals) return null;
  const amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  return amount > 0n && amount < 2n ** 256n ? amount : null;
}

export function tradeLimit(total: bigint, buy: boolean, slippageBps = 50): bigint {
  if (total <= 0n || !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 500) {
    throw new Error("Invalid RWA trade limit");
  }
  return buy ? (total * BigInt(10_000 + slippageBps) + 9999n) / 10_000n
    : total * BigInt(10_000 - slippageBps) / 10_000n;
}

export type RwaRead = (contract: RwaAddress, functionName: string, args?: readonly unknown[]) => Promise<unknown>;
export interface RwaState {
  owner: RwaAddress;
  paused: boolean;
  liquidity: bigint;
  fees: bigint;
  withdrawable: bigint;
  reserveFloor: bigint;
  dailyRemaining: bigint;
  maxTradeValue: bigint;
  inventory: bigint;
  assetBalance: bigint;
  settlementBalance: bigint;
  price: bigint | null;
  priceUpdatedAt: bigint | null;
}

function integer(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 0n) throw new Error("Invalid RWA contract response");
  return value;
}

export async function readRwaState(read: RwaRead, config: RwaMarketConfig, account?: RwaAddress): Promise<RwaState> {
  const names = ["asset", "settlement", "assetDecimals", "settlementDecimals", "FEE_BPS", "owner", "paused",
    "availableLiquidity", "feeReserve", "withdrawableFees", "reserveFloor", "remainingDailySell", "maxTradeValue", "oracle"];
  const values = await Promise.all(names.map((name) => read(config.market, name)));
  if (typeof values[0] !== "string" || values[0].toLowerCase() !== config.asset.toLowerCase()
    || typeof values[1] !== "string" || values[1].toLowerCase() !== config.settlement.toLowerCase()
    || values[2] !== config.assetDecimals || values[3] !== config.settlementDecimals || values[4] !== 100n
    || !address(values[5]) || typeof values[6] !== "boolean" || !address(values[13])) {
    throw new Error("RWA deployment does not match the verified catalog");
  }
  const [inventory, held, cash, priceResult] = await Promise.all([
    read(config.asset, "balanceOf", [config.market]),
    account ? read(config.asset, "balanceOf", [account]) : 0n,
    account ? read(config.settlement, "balanceOf", [account]) : 0n,
    read(values[13], "readPriceWad").catch(() => null),
  ]);
  const price = Array.isArray(priceResult) && typeof priceResult[0] === "bigint" && priceResult[0] > 0n
    && typeof priceResult[1] === "bigint" && priceResult[1] > 0n ? priceResult : null;
  return {
    owner: values[5], paused: values[6], liquidity: integer(values[7]), fees: integer(values[8]),
    withdrawable: integer(values[9]), reserveFloor: integer(values[10]), dailyRemaining: integer(values[11]),
    maxTradeValue: integer(values[12]), inventory: integer(inventory), assetBalance: integer(held),
    settlementBalance: integer(cash), price: price ? price[0] as bigint : null,
    priceUpdatedAt: price ? price[1] as bigint : null,
  };
}

export function decodeQuote(result: unknown): readonly [bigint, bigint, bigint] {
  if (!Array.isArray(result) || result.length !== 3) throw new Error("Invalid RWA quote");
  const gross = integer(result[0]), fee = integer(result[1]), total = integer(result[2]);
  if (gross === 0n || total === 0n || fee !== (gross + 99n) / 100n
    || (total !== gross + fee && total !== gross - fee)) throw new Error("Invalid RWA quote");
  return [gross, fee, total];
}
