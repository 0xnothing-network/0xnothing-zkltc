import "server-only";

import { createPublicClient, getAddress, http, type Address } from "viem";
import { litvm, LITVM_RPC_URL } from "@/config/wagmi";
import { marketplaceNftKey } from "@/lib/marketplaceAbi";
import { createBoundedCache } from "@/lib/boundedCache";
import { isUnsafeRemoteHostname } from "@/lib/server/networkAddress";
import { readLimitedBytes } from "@/lib/server/readLimitedBytes";
import { normalizeUint256TokenId } from "@/lib/tokenId";

const ERC721_METADATA_ABI = [
  {
    type: "function",
    name: "tokenURI",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
  },
] as const;

const METADATA_TTL = 5 * 60_000;
const METADATA_TIMEOUT_MS = 5_000;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_CACHE_ENTRIES = 2_048;

const directPublicClient = createPublicClient({
  chain: litvm,
  transport: http(LITVM_RPC_URL, {
    batch: { batchSize: 100, wait: 10 },
    retryCount: 2,
    retryDelay: 300,
    timeout: 15_000,
  }),
});

export interface ValidatedErc721Metadata {
  tokenId: string;
  name: string;
  imageUrl: string;
  creator: Address;
  mintedAt: number;
}

export function validatedErc721MetadataFromJson(
  json: Record<string, unknown>,
  collection: Address,
  tokenId: string,
): ValidatedErc721Metadata | null {
  const imageUrl = metadataImage(json);
  if (!imageUrl) return null;
  return {
    tokenId,
    name: metadataName(json) || `Token #${tokenId}`,
    imageUrl,
    creator: collection,
    mintedAt: 0,
  };
}

interface MetadataRequest {
  collection: Address;
  tokenId: string;
}

// A failed read is cached as null on purpose: an unreachable or malformed token
// URI should not be retried on every marketplace page render.
const metadataCache = createBoundedCache<ValidatedErc721Metadata | null>({
  maxEntries: MAX_CACHE_ENTRIES,
  ttlMs: METADATA_TTL,
  maxInFlight: MAX_CACHE_ENTRIES,
});

export async function fetchValidatedErc721Metadata(
  requests: MetadataRequest[],
): Promise<Record<string, ValidatedErc721Metadata | null>> {
  const unique = new Map<string, MetadataRequest>();
  for (const request of requests) {
    const tokenId = normalizeUint256TokenId(request.tokenId);
    if (!tokenId) continue;
    const collection = getAddress(request.collection);
    unique.set(marketplaceNftKey(collection, tokenId), {
      collection,
      tokenId,
    });
  }

  const output: Record<string, ValidatedErc721Metadata | null> = {};
  await mapWithConcurrency([...unique.entries()], 8, async ([key, request]) => {
    output[key] = await metadataCache.load(key, () => loadTokenMetadata(request));
  });
  return output;
}

async function loadTokenMetadata(request: MetadataRequest): Promise<ValidatedErc721Metadata | null> {
  try {
    const tokenUri = (await directPublicClient.readContract({
      address: request.collection,
      abi: ERC721_METADATA_ABI,
      functionName: "tokenURI",
      args: [BigInt(request.tokenId)],
    })) as string;
    const json = await readMetadataJson(tokenUri);
    return json
      ? validatedErc721MetadataFromJson(json, request.collection, request.tokenId)
      : null;
  } catch (error) {
    console.warn(
      `[marketplace] ERC-721 metadata unavailable for ${request.collection}:${request.tokenId}:`,
      error,
    );
    return null;
  }
}

async function readMetadataJson(uri: string): Promise<Record<string, unknown> | null> {
  const trimmed = uri.trim();
  if (!trimmed || Buffer.byteLength(trimmed, "utf8") > MAX_METADATA_BYTES * 2) {
    return null;
  }

  let text = "";
  if (trimmed.startsWith("{")) {
    text = trimmed;
  } else if (trimmed.startsWith("data:application/json")) {
    const comma = trimmed.indexOf(",");
    if (comma < 0) return null;
    const header = trimmed.slice(0, comma);
    const body = trimmed.slice(comma + 1);
    text = /;base64(?:;|$)/i.test(header)
      ? Buffer.from(body, "base64").toString("utf8")
      : decodeURIComponent(body);
  } else {
    const url = metadataFetchUrl(trimmed);
    if (!url) return null;
    const response = await fetch(url, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    text = await readLimitedResponse(response);
  }

  if (!text || Buffer.byteLength(text, "utf8") > MAX_METADATA_BYTES) return null;
  const parsed: unknown = JSON.parse(text);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

async function readLimitedResponse(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_METADATA_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("NFT metadata exceeds size limit");
  }
  if (!response.body) return "";
  const bytes = await readLimitedBytes(
    response.body,
    MAX_METADATA_BYTES,
    () => new Error("NFT metadata exceeds size limit"),
  );
  return Buffer.from(bytes).toString("utf8");
}

function metadataName(json: Record<string, unknown>): string {
  const value = json.name;
  return typeof value === "string" ? value.trim().slice(0, 256) : "";
}

function metadataImage(json: Record<string, unknown>): string {
  const candidates = [json.image, json.image_url, json.imageUrl];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = normalizeAssetUri(candidate.trim());
    if (normalized) return normalized;
  }

  if (typeof json.image_data === "string") {
    const svg = json.image_data.trim();
    if (svg.startsWith("<svg") && Buffer.byteLength(svg, "utf8") <= MAX_METADATA_BYTES) {
      return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
    }
  }
  return "";
}

function normalizeAssetUri(value: string): string {
  if (!value) return "";
  if (/^data:image\/(?:svg\+xml|png|jpe?g|webp|gif)(?:;|,)/i.test(value)) {
    return Buffer.byteLength(value, "utf8") <= MAX_METADATA_BYTES * 2 ? value : "";
  }
  if (value.startsWith("ipfs://")) {
    const path = value.slice("ipfs://".length).replace(/^ipfs\//, "");
    return path ? `https://ipfs.io/ipfs/${path}` : "";
  }
  if (value.startsWith("ar://")) {
    const path = value.slice("ar://".length);
    return path ? `https://arweave.net/${path}` : "";
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !isUnsafeRemoteHostname(url.hostname)
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

function metadataFetchUrl(value: string): string | null {
  let candidate = value;
  if (value.startsWith("ipfs://")) {
    const path = value.slice("ipfs://".length).replace(/^ipfs\//, "");
    candidate = `https://ipfs.io/ipfs/${path}`;
  } else if (value.startsWith("ar://")) {
    candidate = `https://arweave.net/${value.slice("ar://".length)}`;
  }

  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return isUnsafeRemoteHostname(url.hostname) ? null : url.toString();
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex++];
        await mapper(item);
      }
    }),
  );
}
