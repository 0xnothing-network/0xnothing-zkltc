import fs from "node:fs";
import path from "node:path";
import { loadConfig, packageRoot } from "./config.mjs";

const config = loadConfig();
const templatePath = path.join(packageRoot, "subgraph.template.yaml");
const outputPath = path.join(packageRoot, "subgraph.yaml");

const manifest = fs
  .readFileSync(templatePath, "utf8")
  .replaceAll("__NETWORK__", config.network)
  .replaceAll("__CONTRACT_ADDRESS__", config.contractAddress)
  .replaceAll("__START_BLOCK__", String(config.startBlock));

if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== manifest) {
  fs.writeFileSync(outputPath, manifest);
}

console.log(
  `Configured ${config.deploymentName} for ${config.network} at ${config.contractAddress} from block ${config.startBlock}`,
);
