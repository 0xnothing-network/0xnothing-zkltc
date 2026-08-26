import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { privateKeyToAccount } from "viem/accounts";

import { primaryRpcUrl } from "./lib/rpc.mjs";
import { runStep } from "./lib/spawn-step.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });
const modes = ["--dry-run", "--broadcast", "--resume", "--finalize-only"].filter((flag) => process.argv.includes(flag));
const unknown = process.argv.slice(2).filter((argument) => argument.startsWith("--") && !modes.includes(argument));
if (modes.length !== 1 || unknown.length) {
  throw new Error("Choose exactly one of --dry-run, --broadcast, --resume, or --finalize-only");
}
const mode = modes[0];
const network = JSON.parse(fs.readFileSync(path.join(root, "config", "liteforge-testnet.json"), "utf8"));
const deployment = JSON.parse(fs.readFileSync(path.join(root, "contracts", "deployments", "latest.json"), "utf8"));
const receiptPath = path.join(root, "contracts", "broadcast", "DisableTimelockTestnet.s.sol", String(network.chainId), "run-latest.json");
if (mode === "--broadcast" && fs.existsSync(receiptPath)) {
  throw new Error("A direct-governance broadcast journal already exists; use resume or finalize");
}
if ((mode === "--resume" || mode === "--finalize-only") && !fs.existsSync(receiptPath)) {
  throw new Error("No direct-governance broadcast journal exists");
}

const run = (command, args, extraEnv = {}, cwd = root) => runStep(command, args, extraEnv, cwd);

if (mode !== "--finalize-only") {
  const rawKey = (process.env.DEPLOYER_PRIVATE_KEY || process.env.API_KEY || "").trim();
  const privateKey = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("DEPLOYER_PRIVATE_KEY/API_KEY must be a 32-byte key");
  const account = privateKeyToAccount(privateKey);
  if (account.address.toLowerCase() !== String(deployment.deployer).toLowerCase()) {
    throw new Error("Configured wallet does not match the deployment owner");
  }
  // Forge resume replays only unsent journal transactions and does not simulate
  // the script. A partially completed admin handover can legitimately fail the
  // original topology preflight, so rely on the journal nonce checks here and
  // the exhaustive finalizer below.
  if (mode !== "--resume") {
    await run(process.execPath, [path.join(root, "scripts", "preflight.mjs")]);
  }
  const args = [
    "script",
    "script/DisableTimelockTestnet.s.sol:DisableTimelockTestnet",
    "--rpc-url",
    primaryRpcUrl(network),
  ];
  if (mode !== "--resume") args.push("--force");
  if (mode === "--broadcast") args.push("--broadcast", "--slow");
  if (mode === "--resume") args.push("--resume", "--broadcast", "--slow");
  await run("forge", args, { PRIVATE_KEY: privateKey }, path.join(root, "contracts"));
}

if (mode === "--broadcast" || mode === "--resume" || mode === "--finalize-only") {
  await run(process.execPath, [path.join(root, "scripts", "finalize-direct-governance.mjs")]);
}
