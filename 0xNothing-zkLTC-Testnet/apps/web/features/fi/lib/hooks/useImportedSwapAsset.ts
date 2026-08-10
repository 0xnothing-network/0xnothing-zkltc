"use client";

import { useEffect, useMemo, useState } from "react";
import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { fiPath } from "@fi/config/paths";
import type {
  ImportedTokenApiResponse,
  ImportedTokenExplorerStatus,
  ImportedTokenMetadata,
  ImportedTokenMetadataSource,
} from "@fi/lib/importedToken";
import type { SwapAsset } from "@fi/lib/hooks/useSwapAssets";

export type ImportedAssetStatus =
  | "idle"
  | "invalid"
  | "loading"
  | "ready"
  | "unavailable"
  | "unsupported";

interface ImportedAssetState {
  asset?: SwapAsset;
  candidateKey?: string;
  error?: string;
  explorerStatus?: ImportedTokenExplorerStatus;
  metadataSource?: ImportedTokenMetadataSource;
  status: ImportedAssetStatus;
}

interface ImportedAssetCacheEntry {
  asset: SwapAsset;
  explorerStatus: ImportedTokenExplorerStatus;
  metadataSource: ImportedTokenMetadataSource;
}

const IMPORT_CACHE = new Map<string, ImportedAssetCacheEntry>();
const SCANNED_ADDRESSES = new Set<string>();
const MAX_SESSION_IMPORTS = 20;
const CLIENT_TIMEOUT_MS = 12_000;
const UNSAFE_METADATA = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

function safeMetadata(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength * 4) return undefined;
  const cleaned = value.replace(UNSAFE_METADATA, "").trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function normalizedCandidate(value: string): Address | undefined {
  const candidate = value.trim();
  if (!candidate || !isAddress(candidate)) return undefined;
  const address = getAddress(candidate);
  return address.toLowerCase() === zeroAddress ? undefined : address;
}

function verifiedMetadata(payload: unknown, candidate: Address): ImportedTokenMetadata | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const record = payload as Partial<ImportedTokenMetadata>;
  if (typeof record.address !== "string" || !isAddress(record.address)) return undefined;
  const address = getAddress(record.address);
  if (address.toLowerCase() !== candidate.toLowerCase()) return undefined;
  const symbol = safeMetadata(record.symbol, 32);
  const name = safeMetadata(record.name, 96) ?? symbol;
  if (!symbol || !name) return undefined;
  if (!Number.isInteger(record.decimals) || record.decimals! < 0 || record.decimals! > 36) return undefined;
  if (typeof record.totalSupply !== "string" || !/^\d{1,78}$/.test(record.totalSupply)) return undefined;
  if (record.metadataSource !== "explorer" && record.metadataSource !== "onchain") return undefined;
  if (!(["verified", "not-indexed", "unavailable", "invalid"] as const).includes(
    record.explorerStatus as ImportedTokenExplorerStatus,
  )) return undefined;
  return {
    address,
    decimals: record.decimals!,
    explorerStatus: record.explorerStatus!,
    metadataSource: record.metadataSource,
    name,
    symbol,
    totalSupply: record.totalSupply,
  };
}

function responseError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fallback;
  const value = (payload as { error?: unknown }).error;
  return typeof value === "string" && value.length > 0 && value.length <= 160 ? value : fallback;
}

export function useImportedSwapAsset(value: string, enabled = true) {
  const candidate = useMemo(() => normalizedCandidate(value), [value]);
  const [state, setState] = useState<ImportedAssetState>({ status: "idle" });

  useEffect(() => {
    const raw = value.trim();
    if (!raw || !enabled) {
      setState({ status: "idle" });
      return;
    }
    if (!candidate) {
      setState({ status: "invalid", error: "Enter a complete 0x contract address." });
      return;
    }

    const cacheKey = candidate.toLowerCase();
    const cached = IMPORT_CACHE.get(cacheKey);
    if (cached) {
      setState({
        status: "ready",
        asset: cached.asset,
        candidateKey: cacheKey,
        explorerStatus: cached.explorerStatus,
        metadataSource: cached.metadataSource,
      });
      return;
    }
    if (!SCANNED_ADDRESSES.has(cacheKey) && SCANNED_ADDRESSES.size >= MAX_SESSION_IMPORTS) {
      setState({ status: "unsupported", candidateKey: cacheKey, error: "Token scan limit reached for this session." });
      return;
    }
    SCANNED_ADDRESSES.add(cacheKey);

    let cancelled = false;
    const controller = new AbortController();
    setState({ status: "loading", candidateKey: cacheKey });
    const requestTimeout = window.setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
    const debounceTimer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(fiPath(`/api/token/${candidate}`), {
            headers: { Accept: "application/json" },
            signal: controller.signal,
          });
          const payload = await response.json().catch(() => undefined) as ImportedTokenApiResponse | undefined;
          if (!response.ok || !payload || payload.status !== "ready") {
            if (cancelled) return;
            const unavailable = response.status >= 500 || payload?.status === "unavailable";
            setState({
              status: unavailable ? "unavailable" : response.status === 400 ? "invalid" : "unsupported",
              candidateKey: cacheKey,
              error: responseError(payload, unavailable
                ? "Token verification is temporarily unavailable."
                : "This address is not a supported ERC-20 token."),
              explorerStatus: payload && "explorerStatus" in payload ? payload.explorerStatus : undefined,
            });
            return;
          }

          const metadata = verifiedMetadata(payload.data, candidate);
          if (!metadata) throw new Error("Token verification returned invalid metadata.");
          const asset: SwapAsset = {
            id: cacheKey,
            symbol: metadata.symbol,
            name: metadata.name,
            decimals: metadata.decimals,
            address: candidate,
            poolAddress: candidate,
            native: false,
            graduated: false,
            imported: true,
            trustedCore: false,
            explorerStatus: metadata.explorerStatus,
            metadataSource: metadata.metadataSource,
          };
          const entry: ImportedAssetCacheEntry = {
            asset,
            explorerStatus: metadata.explorerStatus,
            metadataSource: metadata.metadataSource,
          };
          IMPORT_CACHE.set(cacheKey, entry);
          if (!cancelled) {
            setState({
              status: "ready",
              asset,
              candidateKey: cacheKey,
              explorerStatus: metadata.explorerStatus,
              metadataSource: metadata.metadataSource,
            });
          }
        } catch (error) {
          if (cancelled) return;
          setState({
            status: "unavailable",
            candidateKey: cacheKey,
            error: error instanceof Error && error.message.startsWith("Token verification returned")
              ? error.message
              : "Token verification is temporarily unavailable.",
          });
        }
      })();
    }, 280);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(debounceTimer);
      window.clearTimeout(requestTimeout);
    };
  }, [candidate, enabled, value]);

  const candidateKey = candidate?.toLowerCase();
  const visibleState: ImportedAssetState = !enabled || !value.trim()
    ? { status: "idle" }
    : !candidateKey
      ? { status: "invalid", error: "Enter a complete 0x contract address." }
      : state.candidateKey === candidateKey
        ? state
        : { status: "loading", candidateKey };

  return { ...visibleState, address: candidate };
}
