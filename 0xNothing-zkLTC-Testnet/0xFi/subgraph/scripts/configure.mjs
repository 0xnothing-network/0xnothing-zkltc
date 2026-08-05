import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(fs.readFileSync(path.join(root, "subgraph.config.json"), "utf8"));
const required = [
  "network",
  "factoryAddress",
  "gaugeFactoryAddress",
  "nbtcVaultAddress",
  "nethVaultAddress",
  "lendingPoolAddress",
  "nusdAddress",
  "startBlock",
  "factoryStartBlock",
  "gaugeFactoryStartBlock",
  "nbtcVaultStartBlock",
  "nethVaultStartBlock",
  "lendingPoolStartBlock",
];
for (const key of required) {
  if (config[key] === undefined || config[key] === null || config[key] === "") {
    throw new Error(`Missing subgraph config value: ${key}`);
  }
}

const hasSynthFeeFactory = config.synthFeeGaugeFactoryAddress !== undefined
  && config.synthFeeGaugeFactoryStartBlock !== undefined;
if ((config.synthFeeGaugeFactoryAddress === undefined) !== (config.synthFeeGaugeFactoryStartBlock === undefined)) {
  throw new Error("Synth fee gauge factory address and start block must be configured together");
}

let template = fs.readFileSync(path.join(root, "subgraph.template.yaml"), "utf8");
if (hasSynthFeeFactory) {
  template = template
    .replaceAll("__SYNTH_FEE_GAUGE_FACTORY_ADDRESS__", config.synthFeeGaugeFactoryAddress)
    .replaceAll("__SYNTH_FEE_GAUGE_FACTORY_START_BLOCK__", String(config.synthFeeGaugeFactoryStartBlock));
} else {
  template = template.replace(
    /\n  # SYNTH_FEE_GAUGE_FACTORY_START\n[\s\S]*?\n  # SYNTH_FEE_GAUGE_FACTORY_END\n/,
    "\n",
  );
}

const manifest = template
  .replaceAll("__NETWORK__", config.network)
  .replaceAll("__FACTORY_ADDRESS__", config.factoryAddress)
  .replaceAll("__GAUGE_FACTORY_ADDRESS__", config.gaugeFactoryAddress)
  .replaceAll("__NBTC_VAULT_ADDRESS__", config.nbtcVaultAddress)
  .replaceAll("__NETH_VAULT_ADDRESS__", config.nethVaultAddress)
  .replaceAll("__LENDING_POOL_ADDRESS__", config.lendingPoolAddress)
  .replaceAll("__NUSD_ADDRESS__", config.nusdAddress)
  .replaceAll("__FACTORY_START_BLOCK__", String(config.factoryStartBlock))
  .replaceAll("__GAUGE_FACTORY_START_BLOCK__", String(config.gaugeFactoryStartBlock))
  .replaceAll("__NBTC_VAULT_START_BLOCK__", String(config.nbtcVaultStartBlock))
  .replaceAll("__NETH_VAULT_START_BLOCK__", String(config.nethVaultStartBlock))
  .replaceAll("__LENDING_POOL_START_BLOCK__", String(config.lendingPoolStartBlock));
if (/__[A-Z0-9_]+__/.test(manifest)) throw new Error("Subgraph template contains unresolved placeholders");

const output = path.join(root, "subgraph.yaml");
if (!fs.existsSync(output) || fs.readFileSync(output, "utf8") !== manifest) fs.writeFileSync(output, manifest);
console.log(`Configured ${config.deploymentName} on ${config.network} from block ${config.startBlock}`);
