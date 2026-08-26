import { NextResponse } from "next/server";
import { isIP } from "node:net";
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { deployment } from "@fi/config/deployment";
import { erc20Abi } from "@fi/lib/abis/erc20";
import { createBoundedCache } from "@/lib/boundedCache";
import type {
  ImportedTokenApiResponse,
  ImportedTokenExplorerStatus,
  ImportedTokenMetadata,
} from "@fi/lib/importedToken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXPLORER_TIMEOUT_MS = 4_500;
const RPC_TIMEOUT_MS = 7_500;
const MAX_EXPLORER_BODY_BYTES = 64 * 1024;
const MAX_METADATA_RESULT_BYTES = 512;
const METADATA_CALL_GAS_LIMIT = 250_000n;
const MAX_UINT256 = (1n << 256n) - 1n;
const SUCCESS_CACHE_CONTROL = "public, max-age=15, s-maxage=60, stale-while-revalidate=120";
const MISS_CACHE_CONTROL = "public, max-age=5, s-maxage=10, stale-while-revalidate=15";
const POSITIVE_CACHE_TTL_MS = 60_000;
const NEGATIVE_CACHE_TTL_MS = 15_000;
const MAX_LOOKUP_CACHE_ENTRIES = 512;
const RATE_LIMIT_CAPACITY = 20;
const RATE_LIMIT_REFILL_MS = 3_000;
const RATE_LIMIT_BUCKET_TTL_MS = 10 * 60_000;
const MAX_RATE_LIMIT_BUCKETS = 2_048;
const RATE_LIMIT_SWEEP_INTERVAL_MS = 60_000;
const MAX_ACTIVE_LOOKUPS = 8;
const UNSAFE_METADATA = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

type LookupResult = {
  cacheControl: string;
  payload: ImportedTokenApiResponse;
  status: number;
};

type RateLimitBucket = {
  tokens: number;
  updatedAt: number;
};

const lookupCache = createBoundedCache<LookupResult>({
  maxEntries: MAX_LOOKUP_CACHE_ENTRIES,
  maxInFlight: MAX_ACTIVE_LOOKUPS,
});
const rateLimitBuckets = new Map<string, RateLimitBucket>();
let lastRateLimitSweep = 0;

const client = createPublicClient({
  transport: http(deployment.chain.rpcUrl, {
    batch: { batchSize: 100, wait: 10 },
    retryCount: 1,
    retryDelay: 250,
    timeout: RPC_TIMEOUT_MS,
  }),
});

interface ExplorerLookup {
  metadata?: Omit<ImportedTokenMetadata, "explorerStatus" | "metadataSource">;
  status: ImportedTokenExplorerStatus;
}

interface OnchainLookup {
  metadata?: Omit<ImportedTokenMetadata, "explorerStatus" | "metadataSource">;
  status: "unavailable" | "unsupported" | "verified";
}

function normalizedIp(value: string | null): string | undefined {
  if (!value) return undefined;
  let candidate = value.trim().replace(/^"|"$/g, "");
  if (!candidate) return undefined;

  if (candidate.startsWith("[")) {
    const closingBracket = candidate.indexOf("]");
    if (closingBracket > 1) candidate = candidate.slice(1, closingBracket);
  } else if (isIP(candidate) === 0) {
    const separator = candidate.lastIndexOf(":");
    if (separator > 0 && /^\d+$/.test(candidate.slice(separator + 1))) {
      const withoutPort = candidate.slice(0, separator);
      if (isIP(withoutPort) !== 0) candidate = withoutPort;
    }
  }

  return isIP(candidate) !== 0 ? candidate.toLowerCase() : undefined;
}

function rightmostForwardedIp(value: string | null): string | undefined {
  if (!value) return undefined;
  const entries = value.split(",");
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidate = normalizedIp(entries[index]);
    if (candidate) return candidate;
  }
  return undefined;
}

function trustedClientKey(request: Request): string {
  // Configure this only when the origin is reachable through a reverse proxy
  // that overwrites the selected header (for example, x-forwarded-for).
  const configuredHeader = process.env.FI_TRUSTED_PROXY_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (configuredHeader && /^[a-z0-9-]{1,64}$/.test(configuredHeader)) {
    const value = request.headers.get(configuredHeader);
    const address = configuredHeader.includes("forwarded")
      ? rightmostForwardedIp(value)
      : normalizedIp(value);
    if (address) return `${configuredHeader}:${address}`;
  }

  if (process.env.VERCEL === "1") {
    const address = rightmostForwardedIp(request.headers.get("x-vercel-forwarded-for"))
      ?? rightmostForwardedIp(request.headers.get("x-forwarded-for"))
      ?? normalizedIp(request.headers.get("x-real-ip"));
    if (address) return `vercel:${address}`;
  }

  // Without an explicitly trusted reverse proxy there is no trustworthy
  // remote address on the Web Request API. A shared fallback cannot be
  // bypassed by spoofing arbitrary forwarding headers.
  return "unidentified-client";
}

function pruneRateLimitBuckets(now: number): void {
  if (
    rateLimitBuckets.size < MAX_RATE_LIMIT_BUCKETS
    && now - lastRateLimitSweep < RATE_LIMIT_SWEEP_INTERVAL_MS
  ) return;

  lastRateLimitSweep = now;
  for (const [key, bucket] of rateLimitBuckets) {
    if (now - bucket.updatedAt >= RATE_LIMIT_BUCKET_TTL_MS) rateLimitBuckets.delete(key);
  }
  while (rateLimitBuckets.size >= MAX_RATE_LIMIT_BUCKETS) {
    const oldest = rateLimitBuckets.keys().next().value as string | undefined;
    if (!oldest) break;
    rateLimitBuckets.delete(oldest);
  }
}

function consumeLookupToken(request: Request): { allowed: true } | { allowed: false; retryAfter: number } {
  const now = Date.now();
  pruneRateLimitBuckets(now);
  const key = trustedClientKey(request);
  const current = rateLimitBuckets.get(key);
  const elapsed = current ? Math.max(0, now - current.updatedAt) : 0;
  const tokens = current
    ? Math.min(RATE_LIMIT_CAPACITY, current.tokens + elapsed / RATE_LIMIT_REFILL_MS)
    : RATE_LIMIT_CAPACITY;

  rateLimitBuckets.delete(key);
  if (tokens < 1) {
    rateLimitBuckets.set(key, { tokens, updatedAt: now });
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((1 - tokens) * RATE_LIMIT_REFILL_MS / 1_000)),
    };
  }

  rateLimitBuckets.set(key, { tokens: tokens - 1, updatedAt: now });
  return { allowed: true };
}

function metadataText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength * 4) return undefined;
  const cleaned = value.replace(UNSAFE_METADATA, "").trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function tokenDecimals(value: unknown): number | undefined {
  const candidate = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d{1,3}$/.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isInteger(candidate) && candidate >= 0 && candidate <= 36 ? candidate : undefined;
}

function tokenSupply(value: unknown): string | undefined {
  const candidate = typeof value === "bigint"
    ? value
    : typeof value === "string" && /^\d{1,78}$/.test(value)
      ? BigInt(value)
      : undefined;
  return candidate !== undefined && candidate >= 0n && candidate <= MAX_UINT256
    ? candidate.toString()
    : undefined;
}

function explorerEndpoint(address: Address): URL | undefined {
  try {
    const configured = new URL(deployment.chain.explorerUrl);
    if (configured.protocol !== "https:") return undefined;
    return new URL(`/api/v2/tokens/${address}`, configured.origin);
  } catch {
    return undefined;
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The connection may already be closed. There is nothing else to drain.
  }
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string | undefined> {
  const declaredLength = response.headers.get("content-length")?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    try {
      if (BigInt(declaredLength) > BigInt(maxBytes)) {
        await cancelBody(response);
        return undefined;
      }
    } catch {
      await cancelBody(response);
      return undefined;
    }
  }

  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } catch {
    try {
      await reader.cancel();
    } catch {
      // Ignore a second stream error while releasing the response body.
    }
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

async function lookupExplorer(address: Address): Promise<ExplorerLookup> {
  const endpoint = explorerEndpoint(address);
  if (!endpoint) return { status: "unavailable" };

  let response: Response;
  try {
    response = await fetch(endpoint, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(EXPLORER_TIMEOUT_MS),
    });
  } catch {
    return { status: "unavailable" };
  }

  if (response.status === 404) {
    await cancelBody(response);
    return { status: "not-indexed" };
  }
  if (!response.ok) {
    await cancelBody(response);
    return { status: "unavailable" };
  }

  let body: unknown;
  try {
    const raw = await boundedResponseText(response, MAX_EXPLORER_BODY_BYTES);
    if (!raw) return { status: "invalid" };
    body = JSON.parse(raw) as unknown;
  } catch {
    return { status: "invalid" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: "invalid" };

  const record = body as Record<string, unknown>;
  const reportedAddress = typeof record.address === "string"
    ? record.address
    : typeof record.address_hash === "string" ? record.address_hash : undefined;
  if (!reportedAddress || !isAddress(reportedAddress)) return { status: "invalid" };
  if (getAddress(reportedAddress).toLowerCase() !== address.toLowerCase()) return { status: "invalid" };
  if (typeof record.type !== "string" || record.type.toUpperCase() !== "ERC-20") {
    return { status: "invalid" };
  }

  const symbol = metadataText(record.symbol, 32);
  const name = metadataText(record.name, 96) ?? symbol;
  const decimals = tokenDecimals(record.decimals);
  const totalSupply = tokenSupply(record.total_supply);
  if (!symbol || !name || decimals === undefined || totalSupply === undefined) {
    return { status: "invalid" };
  }

  return {
    metadata: { address, decimals, name, symbol, totalSupply },
    status: "verified",
  };
}

type Erc20MetadataFunction = "decimals" | "name" | "symbol" | "totalSupply";

function boundedRpcResult(data: Hex | undefined): Hex {
  if (!data || data === "0x" || (data.length - 2) % 2 !== 0) {
    throw new Error("ERC-20 metadata returned invalid data.");
  }
  if ((data.length - 2) / 2 > MAX_METADATA_RESULT_BYTES) {
    throw new Error("ERC-20 metadata response is too large.");
  }
  return data;
}

async function readErc20Metadata(address: Address, functionName: Erc20MetadataFunction): Promise<unknown> {
  const result = await client.call({
    data: encodeFunctionData({ abi: erc20Abi, functionName }),
    gas: METADATA_CALL_GAS_LIMIT,
    to: address,
  });
  return decodeFunctionResult({
    abi: erc20Abi,
    data: boundedRpcResult(result.data),
    functionName,
  });
}

async function lookupOnchain(address: Address): Promise<OnchainLookup> {
  let code;
  try {
    code = await client.getCode({ address });
  } catch {
    return { status: "unavailable" };
  }
  if (!code || code === "0x") return { status: "unsupported" };

  try {
    const [symbolResult, nameResult, decimalsResult, totalSupplyResult] = await Promise.all([
      readErc20Metadata(address, "symbol"),
      readErc20Metadata(address, "name").catch(() => undefined),
      readErc20Metadata(address, "decimals"),
      readErc20Metadata(address, "totalSupply"),
    ]);
    const symbol = metadataText(symbolResult, 32);
    const name = metadataText(nameResult, 96) ?? symbol;
    const decimals = tokenDecimals(decimalsResult);
    const totalSupply = tokenSupply(totalSupplyResult);
    if (!symbol || !name || decimals === undefined || totalSupply === undefined) {
      return { status: "unsupported" };
    }
    return {
      metadata: { address, decimals, name, symbol, totalSupply },
      status: "verified",
    };
  } catch {
    return { status: "unsupported" };
  }
}

function json(
  payload: ImportedTokenApiResponse,
  status: number,
  cacheControl: string,
  headers?: Record<string, string>,
) {
  return NextResponse.json(payload, {
    status,
    headers: {
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

/**
 * A verified token is stable, so it is held for a minute. An "unsupported"
 * verdict is held only briefly because the address may be a contract that is
 * still being deployed, and a transient upstream failure is not cached at all.
 */
function lookupTtl(result: LookupResult): number {
  if (result.status === 200) return POSITIVE_CACHE_TTL_MS;
  return result.status === 422 ? NEGATIVE_CACHE_TTL_MS : 0;
}

async function resolveToken(address: Address): Promise<LookupResult> {
  const explorer = await lookupExplorer(address);
  if (explorer.metadata) {
    return {
      payload: {
        data: {
          ...explorer.metadata,
          explorerStatus: "verified",
          metadataSource: "explorer",
        },
        status: "ready",
      },
      status: 200,
      cacheControl: SUCCESS_CACHE_CONTROL,
    };
  }

  const onchain = await lookupOnchain(address);
  if (onchain.metadata) {
    return {
      payload: {
        data: {
          ...onchain.metadata,
          explorerStatus: explorer.status,
          metadataSource: "onchain",
        },
        status: "ready",
      },
      status: 200,
      cacheControl: SUCCESS_CACHE_CONTROL,
    };
  }
  if (onchain.status === "unavailable") {
    return {
      payload: {
        error: "Token verification is temporarily unavailable.",
        explorerStatus: explorer.status,
        status: "unavailable",
      },
      status: 503,
      cacheControl: "no-store",
    };
  }
  return {
    payload: {
      error: "This address is not a supported ERC-20 token.",
      explorerStatus: explorer.status,
      status: "unsupported",
    },
    status: 422,
    cacheControl: MISS_CACHE_CONTROL,
  };
}

async function resolveTokenCached(address: Address): Promise<LookupResult> {
  const key = address.toLowerCase();
  const cached = lookupCache.get(key);
  if (cached) return cached;

  // A request that would open a new upstream lookup is rejected while the
  // concurrency budget is spent. Joining a lookup already running for this key
  // costs nothing, so it stays allowed.
  if (!lookupCache.pending(key) && lookupCache.saturated()) {
    return {
      payload: {
        error: "Token verification is busy. Try again shortly.",
        status: "unavailable",
      },
      status: 503,
      cacheControl: "no-store",
    };
  }

  return lookupCache.load(key, () => resolveToken(address), lookupTtl);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ address: string }> },
) {
  const rateLimit = consumeLookupToken(request);
  if (!rateLimit.allowed) {
    return json({
      error: "Too many token lookup requests. Try again shortly.",
      status: "unavailable",
    }, 429, "no-store", { "Retry-After": String(rateLimit.retryAfter) });
  }

  const { address: rawAddress } = await context.params;
  if (!isAddress(rawAddress)) {
    return json({ error: "Invalid token contract address.", status: "invalid" }, 400, "no-store");
  }
  const address = getAddress(rawAddress);
  if (address.toLowerCase() === zeroAddress) {
    return json({ error: "Invalid token contract address.", status: "invalid" }, 400, "no-store");
  }

  const result = await resolveTokenCached(address);
  return json(result.payload, result.status, result.cacheControl);
}
