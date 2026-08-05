import { getAddress, isAddress, zeroAddress, type Address } from "viem";

export const LITVM_CHAIN_ID = 4441 as const;

function configuredAddress(value: string | undefined): Address | undefined {
  const candidate = value?.trim();
  if (!candidate || !isAddress(candidate) || candidate.toLowerCase() === zeroAddress) return undefined;
  return getAddress(candidate);
}

function positiveInteger(value: string | undefined): string {
  return value && /^\d+$/.test(value) ? value : "0";
}

export const deployment = {
  appUrl: process.env.NEXT_PUBLIC_APP_URL?.trim() || "http://127.0.0.1:3300/0xFi",
  lendingRiskActionsEnabled: process.env.NEXT_PUBLIC_LENDING_RISK_ACTIONS_ENABLED === "true",
  chain: {
    id: LITVM_CHAIN_ID,
    name: "LitVM LiteForge",
    rpcUrl:
      process.env.NEXT_PUBLIC_LITVM_RPC_URL?.trim() ||
      "https://liteforge.rpc.caldera.xyz/infra-partner-http",
    explorerUrl:
      process.env.NEXT_PUBLIC_LITVM_EXPLORER_URL?.trim() ||
      "https://liteforge.explorer.caldera.xyz",
  },
  indexer: {
    endpoint: process.env.NEXT_PUBLIC_GOLDSKY_ENDPOINT?.trim() || undefined,
    deploymentBlock: positiveInteger(process.env.NEXT_PUBLIC_DEPLOYMENT_BLOCK),
  },
  contracts: {
    nusd: configuredAddress(process.env.NEXT_PUBLIC_NUSD_ADDRESS),
    wzkltc: configuredAddress(process.env.NEXT_PUBLIC_WZKLTC_ADDRESS),
    nbtc: configuredAddress(process.env.NEXT_PUBLIC_NBTC_ADDRESS),
    neth: configuredAddress(process.env.NEXT_PUBLIC_NETH_ADDRESS),
    dexFactory: configuredAddress(process.env.NEXT_PUBLIC_DEX_FACTORY_ADDRESS),
    dexRouter: configuredAddress(process.env.NEXT_PUBLIC_DEX_ROUTER_ADDRESS),
    farmFactory: configuredAddress(
      process.env.NEXT_PUBLIC_GAUGE_FACTORY_ADDRESS || process.env.NEXT_PUBLIC_FARM_FACTORY_ADDRESS,
    ),
    synthSafetyReserve: configuredAddress(process.env.NEXT_PUBLIC_SYNTH_SAFETY_RESERVE_ADDRESS),
    lendingPool: configuredAddress(process.env.NEXT_PUBLIC_LENDING_POOL_ADDRESS),
    nbtcVault: configuredAddress(process.env.NEXT_PUBLIC_NBTC_VAULT_ADDRESS),
    nethVault: configuredAddress(process.env.NEXT_PUBLIC_NETH_VAULT_ADDRESS),
    ltcOracle: configuredAddress(process.env.NEXT_PUBLIC_LTC_ORACLE_ADDRESS),
    btcOracle: configuredAddress(process.env.NEXT_PUBLIC_BTC_ORACLE_ADDRESS),
    ethOracle: configuredAddress(process.env.NEXT_PUBLIC_ETH_ORACLE_ADDRESS),
    diaLtcFeed: configuredAddress(process.env.NEXT_PUBLIC_DIA_LTC_FEED_ADDRESS),
    diaBtcFeed: configuredAddress(process.env.NEXT_PUBLIC_DIA_BTC_FEED_ADDRESS),
    diaEthFeed: configuredAddress(process.env.NEXT_PUBLIC_DIA_ETH_FEED_ADDRESS),
    wzkLtcNusdPair: configuredAddress(process.env.NEXT_PUBLIC_WZKLTC_NUSD_PAIR_ADDRESS),
    nbtcNusdPair: configuredAddress(process.env.NEXT_PUBLIC_NBTC_NUSD_PAIR_ADDRESS),
    nethNusdPair: configuredAddress(process.env.NEXT_PUBLIC_NETH_NUSD_PAIR_ADDRESS),
    pumpGraduationAdapter: configuredAddress(
      process.env.NEXT_PUBLIC_PUMP_GRADUATION_ADAPTER_ADDRESS,
    ),
    pumpGraduationController: configuredAddress(
      process.env.NEXT_PUBLIC_PUMP_GRADUATION_CONTROLLER_ADDRESS,
    ),
    pump: configuredAddress(process.env.NEXT_PUBLIC_PUMP_ADDRESS),
  },
} as const;

export type ContractKey = keyof typeof deployment.contracts;

export function isContractConfigured(key: ContractKey): boolean {
  return Boolean(deployment.contracts[key]);
}

export function explorerAddressUrl(address: Address): string {
  return `${deployment.chain.explorerUrl}/address/${address}`;
}

export function explorerTransactionUrl(hash: `0x${string}`): string {
  return `${deployment.chain.explorerUrl}/tx/${hash}`;
}
