/**
 * Small conveniences the wallet remembers between openings: the Home tab
 * and the swap pair. Both are public (a tab name and token ids) and both are
 * read back through these checks, so a value from another build or a
 * hand-edited store is ignored rather than trusted. Import-free so the tests
 * load it directly; uiMemoryStore.ts does the storage.
 */
export type HomeTab = "token" | "nft" | "rwa";

export interface SwapPair {
  networkId: string;
  inId: string;
  outId: string;
}

const MAX_ID = 200;

export function parseHomeTab(value: unknown): HomeTab | null {
  return value === "token" || value === "nft" || value === "rwa" ? value : null;
}

function id(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID ? value : null;
}

export function parseSwapPair(value: unknown): SwapPair | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const networkId = id(row.networkId);
  const inId = id(row.inId);
  const outId = id(row.outId);
  if (networkId === null || inId === null || outId === null) return null;
  return { networkId, inId, outId };
}

/**
 * The stored pair, if it can be shown as is: same network, both tokens still
 * in the wallet's list, and two different tokens. Otherwise the defaults stay.
 */
export function restorableSwapPair(
  value: unknown,
  networkId: string,
  tokenIds: readonly string[],
): SwapPair | null {
  const pair = parseSwapPair(value);
  if (pair === null || pair.networkId !== networkId || pair.inId === pair.outId) return null;
  if (!tokenIds.includes(pair.inId) || !tokenIds.includes(pair.outId)) return null;
  return pair;
}
