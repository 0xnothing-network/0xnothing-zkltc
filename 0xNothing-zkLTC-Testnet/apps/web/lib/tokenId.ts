const MAX_UINT256 = (1n << 256n) - 1n;

/** Validate and canonicalize an ERC-721 uint256 token identifier. */
export function normalizeUint256TokenId(value: string): string | undefined {
  // uint256 has at most 78 decimal digits. Check length before BigInt parsing
  // so an attacker cannot submit an arbitrarily large integer string.
  if (!/^\d{1,78}$/.test(value)) return undefined;
  const tokenId = BigInt(value);
  return tokenId <= MAX_UINT256 ? tokenId.toString() : undefined;
}
