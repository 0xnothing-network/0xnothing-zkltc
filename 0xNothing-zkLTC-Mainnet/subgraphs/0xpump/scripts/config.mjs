import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};

  const values = {};
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator < 1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function loadConfig() {
  const defaults = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "subgraph.config.json"), "utf8"),
  );
  const fileEnv = parseEnvFile(path.join(packageRoot, ".env"));
  const env = { ...fileEnv, ...process.env };

  const startBlockValue = env.PUMP_START_BLOCK ?? String(defaults.startBlock);
  if (!/^\d+$/u.test(startBlockValue)) {
    throw new Error("PUMP_START_BLOCK must be a non-negative integer");
  }

  const config = {
    ...defaults,
    network: env.GOLDSKY_NETWORK ?? defaults.network,
    contractAddress: env.PUMP_CONTRACT_ADDRESS ?? defaults.contractAddress,
    startBlock: Number(startBlockValue),
  };

  if (!/^0x[0-9a-fA-F]{40}$/u.test(config.contractAddress)) {
    throw new Error("PUMP_CONTRACT_ADDRESS must be a 20-byte EVM address");
  }
  if (!/^[a-zA-Z0-9_-]+$/u.test(config.network)) {
    throw new Error("GOLDSKY_NETWORK contains unsupported characters");
  }
  if (!Number.isSafeInteger(config.startBlock)) {
    throw new Error("PUMP_START_BLOCK is outside JavaScript's safe integer range");
  }

  return config;
}
