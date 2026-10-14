import { isAddress, getAddress, zeroAddress, type Address } from "viem";
import { deployment } from "@fi/config/deployment";

function configuredAddress(value: string | undefined): Address | undefined {
  const candidate = value?.trim();
  if (!candidate || !isAddress(candidate) || candidate.toLowerCase() === zeroAddress) return undefined;
  return getAddress(candidate);
}

export const FAUCET_CHAIN_ID = 4441 as const;
/** LiteForge TestnetFaucet deployed 2026-10-14 (deployments/liteforge-testnet/faucet.json). Env overrides. */
export const DEPLOYED_FAUCET_ADDRESS = "0xFDd7D769C36b3829E8Aa908a5E455832F312FE38";
export const FAUCET_ADDRESS = configuredAddress(process.env.NEXT_PUBLIC_FAUCET_ADDRESS) ?? configuredAddress(DEPLOYED_FAUCET_ADDRESS);
export const FAUCET_NUSD_ADDRESS = deployment.contracts.nusd;
export const FAUCET_CONFIGURED = Boolean(FAUCET_ADDRESS && FAUCET_NUSD_ADDRESS);
export const ZERO_ADDRESS = zeroAddress;
