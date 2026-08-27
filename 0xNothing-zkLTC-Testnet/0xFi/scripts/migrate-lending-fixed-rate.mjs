import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { privateKeyToAccount } from "viem/accounts";

import { resolvePrivateKey } from "./lib/private-key.mjs";
import { primaryRpcUrl } from "./lib/rpc.mjs";
import { runStep } from "./lib/spawn-step.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });

const allowedModes = new Set(["--dry-run", "--broadcast", "--resume", "--finalize-only"]);
const requestedModes = process.argv.slice(2);
if (requestedModes.length !== 1 || !allowedModes.has(requestedModes[0])) {
  throw new Error("Choose exactly one of --dry-run, --broadcast, --resume, or --finalize-only");
}

const mode = requestedModes[0];
const networkPath = path.join(root, "config", "liteforge-testnet.json");
const deploymentPath = path.join(root, "contracts", "deployments", "latest.json");
const predictionPath = path.join(root, "contracts", "deployments", "lending-fixed-rate.json");
const network = JSON.parse(fs.readFileSync(networkPath, "utf8"));
const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
const broadcastPath = path.join(
  root,
  "contracts",
  "broadcast",
  "MigrateLendingFixedRate.s.sol",
  String(network.chainId),
  "run-latest.json",
);
const hasBroadcastJournal = fs.existsSync(broadcastPath);

const migrationFinalized = Boolean(deployment.lendingFixedRateMigration || (
  deployment.lendingImplementationStatus === "fixed-rate-protocol-spread-80-85-90-paused-bootstrap-v2"
  && deployment.lendingImplementationMigrationRequired === false
));
if (migrationFinalized && mode !== "--finalize-only") {
  throw new Error("The fixed-rate lending migration is already finalized; use activation commands");
}
if (migrationFinalized && deployment.lendingRiskActionsEnabled === true) {
  throw new Error("The fixed-rate lending migration is already finalized and activated");
}
if ((mode === "--dry-run" || mode === "--broadcast") && hasBroadcastJournal) {
  throw new Error("A fixed-rate migration journal already exists; use resume or finalize");
}
if ((mode === "--resume" || mode === "--finalize-only") && !hasBroadcastJournal) {
  throw new Error("No fixed-rate migration broadcast journal exists");
}

const run = (command, args, extraEnv = {}, cwd = root) => runStep(command, args, extraEnv, cwd);

if (mode !== "--finalize-only") {
  const { privateKey } = resolvePrivateKey();
  const account = privateKeyToAccount(privateKey);
  if (account.address.toLowerCase() !== String(deployment.deployer).toLowerCase()) {
    throw new Error("Configured wallet does not match the deployment owner");
  }

  const forgeArgs = [
    "script",
    "script/MigrateLendingFixedRate.s.sol:MigrateLendingFixedRate",
    "--rpc-url",
    primaryRpcUrl(network),
  ];
  if (mode !== "--resume") forgeArgs.push("--force");
  if (mode === "--broadcast") forgeArgs.push("--broadcast", "--slow");
  if (mode === "--resume") forgeArgs.push("--resume", "--broadcast", "--slow");
  await run("forge", forgeArgs, { PRIVATE_KEY: privateKey }, path.join(root, "contracts"));
}

if (mode === "--broadcast" || mode === "--resume" || mode === "--finalize-only") {
  await run(process.execPath, [path.join(root, "scripts", "finalize-lending-fixed-rate.mjs")]);
} else {
  if (!fs.existsSync(predictionPath)) throw new Error("Fixed-rate migration prediction is missing");
  const prediction = JSON.parse(fs.readFileSync(predictionPath, "utf8"));
  console.log(JSON.stringify({
    mode: "dry-run",
    status: prediction.status,
    chainId: prediction.chainId,
    oldLendingPool: prediction.oldLendingPool,
    predictedLendingPool: prediction.newLendingPool,
    implementationId: prediction.implementationId,
    migratedNusd: prediction.migratedNusd,
    broadcasted: false,
  }, null, 2));
}
