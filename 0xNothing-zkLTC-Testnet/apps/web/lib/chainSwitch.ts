export const LITVM_CHAIN_ID = 4441 as const;

export function isLitvmChainId(chainId: number | undefined | null): chainId is typeof LITVM_CHAIN_ID {
  return chainId === LITVM_CHAIN_ID;
}

export function requireLitvmChainId(chainId: number | undefined | null): asserts chainId is typeof LITVM_CHAIN_ID {
  if (chainId !== LITVM_CHAIN_ID) {
    throw new Error("Wrong network. Switch to LitVM LiteForge and try again.");
  }
}
