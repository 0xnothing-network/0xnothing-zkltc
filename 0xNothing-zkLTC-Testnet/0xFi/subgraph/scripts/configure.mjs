import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderSubgraphManifest,
  writeFileIfChanged,
} from "../../../../scripts/lib/subgraph-manifest.mjs";

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
const replacements = {
  __NETWORK__: config.network,
  __FACTORY_ADDRESS__: config.factoryAddress,
  __GAUGE_FACTORY_ADDRESS__: config.gaugeFactoryAddress,
  __NBTC_VAULT_ADDRESS__: config.nbtcVaultAddress,
  __NETH_VAULT_ADDRESS__: config.nethVaultAddress,
  __LENDING_POOL_ADDRESS__: config.lendingPoolAddress,
  __FACTORY_START_BLOCK__: config.factoryStartBlock,
  __GAUGE_FACTORY_START_BLOCK__: config.gaugeFactoryStartBlock,
  __NBTC_VAULT_START_BLOCK__: config.nbtcVaultStartBlock,
  __NETH_VAULT_START_BLOCK__: config.nethVaultStartBlock,
  __LENDING_POOL_START_BLOCK__: config.lendingPoolStartBlock,
};
if (hasSynthFeeFactory) {
  replacements.__SYNTH_FEE_GAUGE_FACTORY_ADDRESS__ = config.synthFeeGaugeFactoryAddress;
  replacements.__SYNTH_FEE_GAUGE_FACTORY_START_BLOCK__ = config.synthFeeGaugeFactoryStartBlock;
} else {
  template = template.replace(
    /\n  # SYNTH_FEE_GAUGE_FACTORY_START\n[\s\S]*?\n  # SYNTH_FEE_GAUGE_FACTORY_END\n/,
    "\n",
  );
}

const manifest = renderSubgraphManifest(template, replacements);

const output = path.join(root, "subgraph.yaml");
await writeFileIfChanged(output, manifest);
console.log(`Configured ${config.deploymentName} on ${config.network} from block ${config.startBlock}`);
