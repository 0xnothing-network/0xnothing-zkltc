import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(fs.readFileSync(path.join(root, "subgraph.config.json"), "utf8"));
const publicConfig = JSON.parse(
  fs.readFileSync(path.join(root, "..", "config", "liteforge-testnet.json"), "utf8"),
);
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const addressKeys = [
  "factoryAddress",
  "gaugeFactoryAddress",
  "nbtcVaultAddress",
  "nethVaultAddress",
  "lendingPoolAddress",
  "nusdAddress",
];
if (config.synthFeeGaugeFactoryAddress !== undefined) addressKeys.push("synthFeeGaugeFactoryAddress");
for (const key of addressKeys) {
  if (!addressPattern.test(config[key]) || /^0x0{40}$/i.test(config[key]) || /^0x0{39}1$/i.test(config[key])) {
    throw new Error(`${key} is still a placeholder`);
  }
}
const blockKeys = [
  "startBlock",
  "factoryStartBlock",
  "gaugeFactoryStartBlock",
  "nbtcVaultStartBlock",
  "nethVaultStartBlock",
  "lendingPoolStartBlock",
];
if (config.synthFeeGaugeFactoryStartBlock !== undefined) blockKeys.push("synthFeeGaugeFactoryStartBlock");
for (const key of blockKeys) {
  if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`${key} must be a deployed block`);
  if (config[key] < config.startBlock) throw new Error(`${key} cannot precede the suite deployment block`);
}

const current = publicConfig.deployment?.contracts;
if (!current) throw new Error("Public deployment manifest has no active contract set");
const expected = {
  network: publicConfig.goldsky?.network,
  factoryAddress: current.dexFactory,
  gaugeFactoryAddress: current.gaugeFactory,
  nbtcVaultAddress: current.nBTCVault,
  nethVaultAddress: current.nETHVault,
  lendingPoolAddress: current.lendingPool,
  nusdAddress: publicConfig.existingContracts?.nusd,
  startBlock: Number(publicConfig.deployment?.deploymentBlock),
  deploymentName: String(publicConfig.goldsky?.subgraph || "").split("/")[0],
};
if (current.synthFeeGaugeFactory) {
  expected.synthFeeGaugeFactoryAddress = current.synthFeeGaugeFactory;
  if (config.synthFeeGaugeFactoryStartBlock === undefined) {
    throw new Error("synthFeeGaugeFactoryStartBlock is missing");
  }
} else if (
  config.synthFeeGaugeFactoryAddress !== undefined || config.synthFeeGaugeFactoryStartBlock !== undefined
) {
  throw new Error("Synth fee gauge factory config exists before the deployment is published");
}
for (const [key, expectedValue] of Object.entries(expected)) {
  const actualValue = config[key];
  const matches = typeof expectedValue === "string" && addressPattern.test(expectedValue)
    ? String(actualValue).toLowerCase() === expectedValue.toLowerCase()
    : actualValue === expectedValue;
  if (!matches) throw new Error(`${key} does not match config/liteforge-testnet.json`);
}
console.log(`Deployment config ready for ${config.deploymentName}`);
