import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicConfig = JSON.parse(
  fs.readFileSync(path.join(root, "..", "config", "liteforge-testnet.json"), "utf8"),
);
const environment = new Map();
for (const rawLine of fs.readFileSync(path.join(root, ".env.example"), "utf8").split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const separator = line.indexOf("=");
  if (separator <= 0) throw new Error(`Invalid .env.example line: ${rawLine}`);
  environment.set(line.slice(0, separator), line.slice(separator + 1));
}

const contracts = publicConfig.deployment?.contracts;
if (!contracts) throw new Error("Public deployment manifest has no active contract set");
const expected = {
  NEXT_PUBLIC_LITVM_RPC_URL: publicConfig.rpcUrl,
  NEXT_PUBLIC_LITVM_EXPLORER_URL: publicConfig.explorerUrl,
  NEXT_PUBLIC_GOLDSKY_ENDPOINT: publicConfig.goldsky?.endpoint,
  NEXT_PUBLIC_DEPLOYMENT_BLOCK: String(publicConfig.deployment?.deploymentBlock),
  NEXT_PUBLIC_NUSD_ADDRESS: publicConfig.existingContracts?.nusd,
  NEXT_PUBLIC_WZKLTC_ADDRESS: contracts.wzkLTC,
  NEXT_PUBLIC_NBTC_ADDRESS: contracts.nBTC,
  NEXT_PUBLIC_NETH_ADDRESS: contracts.nETH,
  NEXT_PUBLIC_DEX_FACTORY_ADDRESS: contracts.dexFactory,
  NEXT_PUBLIC_DEX_ROUTER_ADDRESS: contracts.dexRouter,
  NEXT_PUBLIC_GAUGE_FACTORY_ADDRESS: contracts.gaugeFactory,
  NEXT_PUBLIC_SYNTH_SAFETY_RESERVE_ADDRESS: contracts.synthSafetyReserve,
  NEXT_PUBLIC_LENDING_POOL_ADDRESS: contracts.lendingPool,
  NEXT_PUBLIC_LENDING_RISK_ACTIONS_ENABLED: String(
    publicConfig.deployment?.lendingImplementationMigrationRequired === false,
  ),
  NEXT_PUBLIC_NBTC_VAULT_ADDRESS: contracts.nBTCVault,
  NEXT_PUBLIC_NETH_VAULT_ADDRESS: contracts.nETHVault,
  NEXT_PUBLIC_LTC_ORACLE_ADDRESS: contracts.ltcOracle,
  NEXT_PUBLIC_BTC_ORACLE_ADDRESS: contracts.btcOracle,
  NEXT_PUBLIC_ETH_ORACLE_ADDRESS: contracts.ethOracle,
  NEXT_PUBLIC_DIA_LTC_FEED_ADDRESS: publicConfig.dia?.feeds?.wzkLTC,
  NEXT_PUBLIC_DIA_BTC_FEED_ADDRESS: publicConfig.dia?.feeds?.nBTC,
  NEXT_PUBLIC_DIA_ETH_FEED_ADDRESS: publicConfig.dia?.feeds?.nETH,
  NEXT_PUBLIC_WZKLTC_NUSD_PAIR_ADDRESS: contracts.wzkLtcNusdPair,
  NEXT_PUBLIC_NBTC_NUSD_PAIR_ADDRESS: contracts.nBTCNusdPair,
  NEXT_PUBLIC_NETH_NUSD_PAIR_ADDRESS: contracts.nETHNusdPair,
  NEXT_PUBLIC_PUMP_GRADUATION_ADAPTER_ADDRESS: contracts.pumpGraduationAdapter,
  NEXT_PUBLIC_PUMP_GRADUATION_CONTROLLER_ADDRESS: contracts.pumpGraduationController,
  NEXT_PUBLIC_PUMP_ADDRESS: publicConfig.existingContracts?.pump,
};
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
for (const [key, expectedValue] of Object.entries(expected)) {
  const actualValue = environment.get(key);
  if (key === "NEXT_PUBLIC_SYNTH_SAFETY_RESERVE_ADDRESS" && !expectedValue) {
    if (actualValue) throw new Error(`${key} must be empty until the reserve migration is finalized`);
    continue;
  }
  if (!expectedValue) throw new Error(`config/liteforge-testnet.json is missing ${key}`);
  const matches = addressPattern.test(expectedValue)
    ? actualValue?.toLowerCase() === expectedValue.toLowerCase()
    : actualValue === expectedValue;
  if (!matches) throw new Error(`${key} does not match config/liteforge-testnet.json`);
}

console.log("web/.env.example matches the active public deployment");
