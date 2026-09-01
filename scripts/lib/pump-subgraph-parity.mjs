import { readFile } from "node:fs/promises";
import path from "node:path";

export const PUMP_SUBGRAPH_MIRROR_FILES = Object.freeze([
  "abis/PumpToken.json",
  "abis/ZeroXPump.json",
  "schema.graphql",
  "src/mapping.ts",
  "src/tokenMapping.ts",
  "subgraph.template.yaml",
  "tests/event-builders.ts",
  "tests/mapping.test.ts",
  "tsconfig.json",
]);

export async function findPumpSubgraphDrift({
  testnetRoot,
  mainnetRoot,
  files = PUMP_SUBGRAPH_MIRROR_FILES,
}) {
  const drift = [];
  for (const relativePath of files) {
    try {
      const [testnet, mainnet] = await Promise.all([
        readFile(path.resolve(testnetRoot, relativePath)),
        readFile(path.resolve(mainnetRoot, relativePath)),
      ]);
      if (!testnet.equals(mainnet)) drift.push(relativePath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      drift.push(`${relativePath} (${reason})`);
    }
  }
  return drift;
}

export async function assertPumpSubgraphParity(options) {
  const drift = await findPumpSubgraphDrift(options);
  if (drift.length > 0) {
    throw new Error(`Pump testnet/mainnet mirror drift:\n- ${drift.join("\n- ")}`);
  }
  return options.files?.length ?? PUMP_SUBGRAPH_MIRROR_FILES.length;
}
