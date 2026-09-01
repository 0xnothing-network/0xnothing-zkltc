import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import testnet from "@fi/config/testnet.generated.json";

export const LITVM_CHAIN_ID = 4441 as const;

const TESTNET = testnet;

function configuredAddress(value: string | undefined, fallback?: string | null): Address | undefined {
  const candidate = value?.trim() || fallback;
  if (!candidate || !isAddress(candidate) || candidate.toLowerCase() === zeroAddress) return undefined;
  return getAddress(candidate);
}

function booleanOverride(value: string | undefined, fallback: boolean): boolean {
  const candidate = value?.trim().toLowerCase();
  if (candidate === "true") return true;
  if (candidate === "false") return false;
  return fallback;
}

function positiveInteger(value: string | undefined, fallback = "0"): string {
  return value && /^\d+$/.test(value) ? value : fallback;
}

const deploymentOverridesEnabled =
  process.env.NEXT_PUBLIC_ALLOW_DEPLOYMENT_OVERRIDES?.trim().toLowerCase() === "true";

function deploymentOverride(...values: Array<string | undefined>): string | undefined {
  if (!deploymentOverridesEnabled) return undefined;
  return values.find((value) => Boolean(value?.trim()));
}

export const deployment = {
  appUrl: process.env.NEXT_PUBLIC_APP_URL?.trim() || TESTNET.appUrl,
  synthRiskActionsEnabled: booleanOverride(
    deploymentOverride(process.env.NEXT_PUBLIC_SYNTH_RISK_ACTIONS_ENABLED),
    TESTNET.synthRiskActionsEnabled,
  ),
  lendingRiskActionsEnabled: booleanOverride(
    deploymentOverride(process.env.NEXT_PUBLIC_LENDING_RISK_ACTIONS_ENABLED),
    TESTNET.lendingRiskActionsEnabled,
  ),
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
    endpoint: process.env.NEXT_PUBLIC_GOLDSKY_ENDPOINT?.trim() || TESTNET.goldskyEndpoint,
    deploymentBlock: positiveInteger(process.env.NEXT_PUBLIC_DEPLOYMENT_BLOCK, TESTNET.deploymentBlock),
  },
  contracts: {
    nusd: configuredAddress(deploymentOverride(process.env.NEXT_PUBLIC_NUSD_ADDRESS), TESTNET.nusd),
    wzkltc: configuredAddress(deploymentOverride(process.env.NEXT_PUBLIC_WZKLTC_ADDRESS), TESTNET.wzkltc),
    nbtc: configuredAddress(deploymentOverride(process.env.NEXT_PUBLIC_NBTC_ADDRESS), TESTNET.nbtc),
    neth: configuredAddress(deploymentOverride(process.env.NEXT_PUBLIC_NETH_ADDRESS), TESTNET.neth),
    dexFactory: configuredAddress(deploymentOverride(process.env.NEXT_PUBLIC_DEX_FACTORY_ADDRESS), TESTNET.dexFactory),
    dexRouter: configuredAddress(deploymentOverride(process.env.NEXT_PUBLIC_DEX_ROUTER_ADDRESS), TESTNET.dexRouter),
    farmFactory: configuredAddress(
      deploymentOverride(process.env.NEXT_PUBLIC_GAUGE_FACTORY_ADDRESS, process.env.NEXT_PUBLIC_FARM_FACTORY_ADDRESS),
      TESTNET.farmFactory,
    ),
    nusdPointsStaking: configuredAddress(
      deploymentOverride(process.env.NEXT_PUBLIC_0XFI_POINTS_STAKING_ADDRESS),
      TESTNET.nusdPointsStaking,
    ),
    synthFeeGaugeFactory: configuredAddress(
      deploymentOverride(process.env.NEXT_PUBLIC_SYNTH_FEE_GAUGE_FACTORY_ADDRESS),
      TESTNET.synthFeeGaugeFactory,
    ),
    synthSafetyReserve: configuredAddress(
      deploymentOverride(process.env.NEXT_PUBLIC_SYNTH_SAFETY_RESERVE_ADDRESS),
      TESTNET.synthSafetyReserve,
    ),
    lendingPool: configuredAddress(deploymentOverride(process.env.NEXT_PUBLIC_LENDING_POOL_ADDRESS), TESTNET.lendingPool),
    nbtcVault: configuredAddress(deploymentOverride(process.env.NEXT_PUBLIC_NBTC_VAULT_ADDRESS), TESTNET.nbtcVault),
    nethVault: configuredAddress(deploymentOverride(process.env.NEXT_PUBLIC_NETH_VAULT_ADDRESS), TESTNET.nethVault),
    legacyNbtcVault: configuredAddress(
      deploymentOverride(process.env.NEXT_PUBLIC_LEGACY_NBTC_VAULT_ADDRESS),
      TESTNET.legacyNbtcVault,
    ),
    legacyNethVault: configuredAddress(
      deploymentOverride(process.env.NEXT_PUBLIC_LEGACY_NETH_VAULT_ADDRESS),
      TESTNET.legacyNethVault,
    ),
    ltcOracle: configuredAddress(deploymentOverride(process.env.NEXT_PUBLIC_LTC_ORACLE_ADDRESS), TESTNET.ltcOracle),
    btcOracle: configuredAddress(deploymentOverride(process.env.NEXT_PUBLIC_BTC_ORACLE_ADDRESS), TESTNET.btcOracle),
    ethOracle: configuredAddress(deploymentOverride(process.env.NEXT_PUBLIC_ETH_ORACLE_ADDRESS), TESTNET.ethOracle),
    diaLtcFeed: configuredAddress(deploymentOverride(process.env.NEXT_PUBLIC_DIA_LTC_FEED_ADDRESS), TESTNET.diaLtcFeed),
    diaBtcFeed: configuredAddress(deploymentOverride(process.env.NEXT_PUBLIC_DIA_BTC_FEED_ADDRESS), TESTNET.diaBtcFeed),
    diaEthFeed: configuredAddress(deploymentOverride(process.env.NEXT_PUBLIC_DIA_ETH_FEED_ADDRESS), TESTNET.diaEthFeed),
    wzkLtcNusdPair: configuredAddress(deploymentOverride(process.env.NEXT_PUBLIC_WZKLTC_NUSD_PAIR_ADDRESS), TESTNET.wzkLtcNusdPair),
    nbtcNusdPair: configuredAddress(deploymentOverride(process.env.NEXT_PUBLIC_NBTC_NUSD_PAIR_ADDRESS), TESTNET.nbtcNusdPair),
    nethNusdPair: configuredAddress(deploymentOverride(process.env.NEXT_PUBLIC_NETH_NUSD_PAIR_ADDRESS), TESTNET.nethNusdPair),
    wzkLtcNusdGauge: configuredAddress(
      deploymentOverride(process.env.NEXT_PUBLIC_WZKLTC_NUSD_GAUGE_ADDRESS),
      TESTNET.wzkLtcNusdGauge,
    ),
    nbtcNusdGauge: configuredAddress(
      deploymentOverride(process.env.NEXT_PUBLIC_NBTC_NUSD_GAUGE_ADDRESS),
      TESTNET.nbtcNusdGauge,
    ),
    nethNusdGauge: configuredAddress(
      deploymentOverride(process.env.NEXT_PUBLIC_NETH_NUSD_GAUGE_ADDRESS),
      TESTNET.nethNusdGauge,
    ),
    pumpGraduationAdapter: configuredAddress(
      deploymentOverride(process.env.NEXT_PUBLIC_PUMP_GRADUATION_ADAPTER_ADDRESS),
      TESTNET.pumpGraduationAdapter,
    ),
    pumpGraduationController: configuredAddress(
      deploymentOverride(process.env.NEXT_PUBLIC_PUMP_GRADUATION_CONTROLLER_ADDRESS),
      TESTNET.pumpGraduationController,
    ),
    pump: configuredAddress(deploymentOverride(process.env.NEXT_PUBLIC_PUMP_ADDRESS), TESTNET.pump),
    lpLocker: configuredAddress(deploymentOverride(process.env.NEXT_PUBLIC_LP_LOCKER_ADDRESS), TESTNET.lpLocker || undefined),
    tokenMetadataRegistry: configuredAddress(deploymentOverride(process.env.NEXT_PUBLIC_TOKEN_METADATA_REGISTRY_ADDRESS), TESTNET.tokenMetadataRegistry || undefined),
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
