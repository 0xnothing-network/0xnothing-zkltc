import { getAddress, isAddress, zeroAddress, type Address } from "viem";

export const LITVM_CHAIN_ID = 4441 as const;

const TESTNET = {
  appUrl: "https://0xnothing.net/0xFi",
  goldskyEndpoint: "https://api.goldsky.com/api/public/project_cms8vgtcn6a6z01r5fo87d6im/subgraphs/zeroxfi-testnet/staging/gn",
  deploymentBlock: "35303686",
  nusd: "0x5317e21aba902c6c7087a84457bc02fFe99604d1",
  wzkltc: "0xE93d4373CE1eDA3df6c3Ab7ed3ab07A07aA5939F",
  nbtc: "0xc44B6027eBc4859d2E7e2bCF17188C29b1BC1655",
  neth: "0x60590B1f4F17969B8c52c2c0B533404Bbb62206b",
  dexFactory: "0xe33fE815c2e12DC83b69397CeD12b09849Fa9C0D",
  dexRouter: "0xc572A6779ccd69032d9Ce5f74fC47878A6D9c9E3",
  farmFactory: "0x36F425fddc59d281c6ddEaDAc34B32E6f039EB13",
  lendingPool: "0x099Fe8b7611A294eD33e6D96a0b958E189143622",
  nbtcVault: "0x620fB32a1e113aA3D1121baC0c65f919569dF1d3",
  nethVault: "0xA7dA20a8a0d833eFcc0B2ca8189011FCFeab7465",
  ltcOracle: "0x54361dB5F9DF455B448E882Ce65612D5e418f3Ee",
  btcOracle: "0x781178849cE1D131EFbedff1EF52323A6E117813",
  ethOracle: "0x8E9BD05a80542B171719ac0d749a7A609D69E324",
  diaLtcFeed: "0x45dDa5d881BD2C917976CCfde74fFd6f6412da29",
  diaBtcFeed: "0x7d0445782E383223c7B4B660bb96b87213e9b605",
  diaEthFeed: "0xc760B46beF9eD3F9A3d2b825164324D6703F0185",
  wzkLtcNusdPair: "0x8dd79c3966c8392b08b609FAEce029c3329f9E9E",
  nbtcNusdPair: "0xF791643Bb8c86516e9e8a1c4F25cDDc438ced80C",
  nethNusdPair: "0x5cB49442b1684C39FC9348022114FEef6FdB3617",
  pumpGraduationAdapter: "0x935e05f60a05110c29eFA7e3a632dfe38123963e",
  pumpGraduationController: "0x2112Cea76b76817626cA58B205b3dC5560F05857",
  pump: "0x4a0Eaf310e3659aA9B360fD44e90208c31Dbe0e2",
} as const;

function configuredAddress(value: string | undefined, fallback?: string): Address | undefined {
  const candidate = value?.trim() || fallback;
  if (!candidate || !isAddress(candidate) || candidate.toLowerCase() === zeroAddress) return undefined;
  return getAddress(candidate);
}

function positiveInteger(value: string | undefined, fallback = "0"): string {
  return value && /^\d+$/.test(value) ? value : fallback;
}

export const deployment = {
  appUrl: process.env.NEXT_PUBLIC_APP_URL?.trim() || TESTNET.appUrl,
  lendingRiskActionsEnabled: process.env.NEXT_PUBLIC_LENDING_RISK_ACTIONS_ENABLED !== "false",
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
    nusd: configuredAddress(process.env.NEXT_PUBLIC_NUSD_ADDRESS, TESTNET.nusd),
    wzkltc: configuredAddress(process.env.NEXT_PUBLIC_WZKLTC_ADDRESS, TESTNET.wzkltc),
    nbtc: configuredAddress(process.env.NEXT_PUBLIC_NBTC_ADDRESS, TESTNET.nbtc),
    neth: configuredAddress(process.env.NEXT_PUBLIC_NETH_ADDRESS, TESTNET.neth),
    dexFactory: configuredAddress(process.env.NEXT_PUBLIC_DEX_FACTORY_ADDRESS, TESTNET.dexFactory),
    dexRouter: configuredAddress(process.env.NEXT_PUBLIC_DEX_ROUTER_ADDRESS, TESTNET.dexRouter),
    farmFactory: configuredAddress(
      process.env.NEXT_PUBLIC_GAUGE_FACTORY_ADDRESS || process.env.NEXT_PUBLIC_FARM_FACTORY_ADDRESS,
      TESTNET.farmFactory,
    ),
    synthSafetyReserve: configuredAddress(process.env.NEXT_PUBLIC_SYNTH_SAFETY_RESERVE_ADDRESS),
    lendingPool: configuredAddress(process.env.NEXT_PUBLIC_LENDING_POOL_ADDRESS, TESTNET.lendingPool),
    nbtcVault: configuredAddress(process.env.NEXT_PUBLIC_NBTC_VAULT_ADDRESS, TESTNET.nbtcVault),
    nethVault: configuredAddress(process.env.NEXT_PUBLIC_NETH_VAULT_ADDRESS, TESTNET.nethVault),
    ltcOracle: configuredAddress(process.env.NEXT_PUBLIC_LTC_ORACLE_ADDRESS, TESTNET.ltcOracle),
    btcOracle: configuredAddress(process.env.NEXT_PUBLIC_BTC_ORACLE_ADDRESS, TESTNET.btcOracle),
    ethOracle: configuredAddress(process.env.NEXT_PUBLIC_ETH_ORACLE_ADDRESS, TESTNET.ethOracle),
    diaLtcFeed: configuredAddress(process.env.NEXT_PUBLIC_DIA_LTC_FEED_ADDRESS, TESTNET.diaLtcFeed),
    diaBtcFeed: configuredAddress(process.env.NEXT_PUBLIC_DIA_BTC_FEED_ADDRESS, TESTNET.diaBtcFeed),
    diaEthFeed: configuredAddress(process.env.NEXT_PUBLIC_DIA_ETH_FEED_ADDRESS, TESTNET.diaEthFeed),
    wzkLtcNusdPair: configuredAddress(process.env.NEXT_PUBLIC_WZKLTC_NUSD_PAIR_ADDRESS, TESTNET.wzkLtcNusdPair),
    nbtcNusdPair: configuredAddress(process.env.NEXT_PUBLIC_NBTC_NUSD_PAIR_ADDRESS, TESTNET.nbtcNusdPair),
    nethNusdPair: configuredAddress(process.env.NEXT_PUBLIC_NETH_NUSD_PAIR_ADDRESS, TESTNET.nethNusdPair),
    pumpGraduationAdapter: configuredAddress(
      process.env.NEXT_PUBLIC_PUMP_GRADUATION_ADAPTER_ADDRESS,
      TESTNET.pumpGraduationAdapter,
    ),
    pumpGraduationController: configuredAddress(
      process.env.NEXT_PUBLIC_PUMP_GRADUATION_CONTROLLER_ADDRESS,
      TESTNET.pumpGraduationController,
    ),
    pump: configuredAddress(process.env.NEXT_PUBLIC_PUMP_ADDRESS, TESTNET.pump),
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
