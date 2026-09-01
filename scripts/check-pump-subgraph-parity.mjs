import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertPumpSubgraphParity } from "./lib/pump-subgraph-parity.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checked = await assertPumpSubgraphParity({
  testnetRoot: path.join(workspaceRoot, "0xNothing-zkLTC-Testnet", "subgraphs", "0xpump"),
  mainnetRoot: path.join(workspaceRoot, "0xNothing-zkLTC-Mainnet", "subgraphs", "0xpump"),
});

console.log(`Pump subgraph parity checked ${checked} mirrored files.`);
