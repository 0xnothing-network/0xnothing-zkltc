import fs from "node:fs";
import path from "node:path";
import { loadConfig, packageRoot } from "./config.mjs";
import {
  renderSubgraphManifest,
  writeFileIfChanged,
} from "../../../../scripts/lib/subgraph-manifest.mjs";

const config = loadConfig();
const templatePath = path.join(packageRoot, "subgraph.template.yaml");
const outputPath = path.join(packageRoot, "subgraph.yaml");

const manifest = renderSubgraphManifest(fs.readFileSync(templatePath, "utf8"), {
  __NETWORK__: config.network,
  __CONTRACT_ADDRESS__: config.contractAddress,
  __START_BLOCK__: config.startBlock,
});
await writeFileIfChanged(outputPath, manifest);

console.log(
  `Configured ${config.deploymentName} for ${config.network} at ${config.contractAddress} from block ${config.startBlock}`,
);
