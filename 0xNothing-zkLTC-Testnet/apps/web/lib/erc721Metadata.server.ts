import "server-only";

import { createPublicClient, getAddress, http, type Address } from "viem";
import { litvm, LITVM_RPC_URL } from "@/config/wagmi";
import { marketplaceNftKey } from "@/lib/marketplaceAbi";

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

interface CacheEntry {
  value: ValidatedErc721Metadata | null;
  timestamp: number;
}

const metadataCache = new Map<string, CacheEntry>();

export async function fetchValidatedErc721Metadata(
  requests: MetadataRequest[],
): Promise<Record<string, ValidatedErc721Metadata | null>> {
  const unique = new Map<string, MetadataRequest>();
  for (const request of requests) {
    if (!/^\d+$/.test(request.tokenId)) continue;
    const collection = getAddress(request.collection);
    unique.set(marketplaceNftKey(collection, request.tokenId), {
      collection,
      tokenId: BigInt(request.tokenId).toString(),
    });
  }

  const output: Record<string, ValidatedErc721Metadata | null> = {};
  await mapWithConcurrency([...unique.entries()], 8, async ([key, request]) => {
    const cached = metadataCache.get(key);
    if (cached && Date.now() - cached.timestamp < METADATA_TTL) {
      output[key] = cached.value;
      return;
    }

    let value: ValidatedErc721Metadata | null = null;
    try {
      const tokenUri = (await directPublicClient.readContract({
        address: request.collection,
        abi: ERC721_METADATA_ABI,
        functionName: "tokenURI",
        args: [BigInt(request.tokenId)],
      })) as string;
      const json = await readMetadataJson(tokenUri);
      value = json
        ? validatedErc721MetadataFromJson(json, request.collection, request.tokenId)
        : null;
    } catch (error) {
      console.warn(
        `[marketplace] ERC-721 metadata unavailable for ${request.collection}:${request.tokenId}:`,
        error,
      );
    }

    metadataCache.delete(key);
    metadataCache.set(key, { value, timestamp: Date.now() });
    output[key] = value;
  });

  while (metadataCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = metadataCache.keys().next().value;
    if (oldestKey === undefined) break;
    metadataCache.delete(oldestKey);
  }
  return output;
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
    throw new Error("NFT metadata exceeds size limit");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_METADATA_BYTES) {
      await reader.cancel();
      throw new Error("NFT metadata exceeds size limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
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
    return url.protocol === "https:" && !isPrivateHostname(url.hostname)
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
    return isPrivateHostname(url.hostname) ? null : url.toString();
  } catch {
    return null;
  }
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80:")
  ) {
    return true;
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const parts = ipv4.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return true;
  return (
    parts[0] === 0 ||
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] >= 224
  );
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
