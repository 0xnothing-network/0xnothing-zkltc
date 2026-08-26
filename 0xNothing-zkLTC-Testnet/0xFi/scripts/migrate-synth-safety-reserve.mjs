#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

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
const predictionPath = path.join(root, "contracts", "deployments", "synth-safety-reserve.json");
const network = JSON.parse(fs.readFileSync(networkPath, "utf8"));
const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
const lendingPool = getAddress(deployment.lendingPool);
const lendingMigration = deployment.lendingFixedRateMigration;
if (
  deployment.lendingImplementationStatus
      !== "fixed-rate-protocol-spread-80-85-90-paused-bootstrap-v2"
    || deployment.lendingImplementationMigrationRequired !== false
    || !lendingMigration
    || getAddress(lendingMigration.pool).toLowerCase() !== lendingPool.toLowerCase()
    || deployment.lendingFixedRateActivationStatus !== "pending-owner-activation"
    || deployment.lendingRiskActionsEnabled !== false
) {
  throw new Error(
    "Finalize the staged fixed-rate lending migration before running the synth migration",
  );
}
const broadcastPath = path.join(
  root,
  "contracts",
  "broadcast",
  "MigrateSynthSafetyReserve.s.sol",
  String(network.chainId),
  "run-latest.json",
);
const hasBroadcastJournal = fs.existsSync(broadcastPath);
const migrationFinalized = Boolean(deployment.synthSafetyReserveMigration);
const activationComplete = deployment.synthRiskActivationStatus === "active"
  && deployment.synthRiskActionsEnabled === true;

if (activationComplete) {
  throw new Error("The synth safety-reserve migration is already finalized and activated");
}
if (migrationFinalized && mode !== "--finalize-only") {
  throw new Error("The synth safety-reserve migration is already finalized; use activation commands");
}
if ((mode === "--dry-run" || mode === "--broadcast") && hasBroadcastJournal) {
  throw new Error("A synth safety-reserve broadcast journal already exists; use resume or finalize");
}
if ((mode === "--resume" || mode === "--finalize-only") && !hasBroadcastJournal) {
  throw new Error("No synth safety-reserve broadcast journal exists");
}

const run = (command, args, extraEnv = {}, cwd = root) => runStep(command, args, extraEnv, cwd);

if (mode !== "--finalize-only") {
  const rawKey = (process.env.DEPLOYER_PRIVATE_KEY || process.env.API_KEY || "").trim();
  const privateKey = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("DEPLOYER_PRIVATE_KEY/API_KEY must be a 32-byte private key");
  }
  const account = privateKeyToAccount(privateKey);
  if (account.address.toLowerCase() !== String(deployment.deployer).toLowerCase()) {
    throw new Error("Configured wallet does not match the deployment owner");
  }

  const forgeArgs = [
    "script",
    "script/MigrateSynthSafetyReserve.s.sol:MigrateSynthSafetyReserve",
    "--rpc-url",
    primaryRpcUrl(network),
  ];
  if (mode !== "--resume") forgeArgs.push("--force");
  if (mode === "--broadcast") forgeArgs.push("--broadcast", "--slow");
  if (mode === "--resume") forgeArgs.push("--resume", "--broadcast", "--slow");
  await run("forge", forgeArgs, { PRIVATE_KEY: privateKey, LENDING_POOL: lendingPool }, path.join(root, "contracts"));
}

if (mode === "--broadcast" || mode === "--resume" || mode === "--finalize-only") {
  await run(process.execPath, [path.join(root, "scripts", "finalize-synth-safety-reserve.mjs")]);
} else {
  if (!fs.existsSync(predictionPath)) throw new Error("Synth safety-reserve prediction is missing");
  const prediction = JSON.parse(fs.readFileSync(predictionPath, "utf8"));
  if (getAddress(prediction.lendingPool).toLowerCase() !== lendingPool.toLowerCase()) {
    throw new Error("Synth prediction used a different lending pool");
  }
  console.log(JSON.stringify({
    mode: "dry-run",
    status: prediction.status,
    chainId: prediction.chainId,
    lendingPool,
    synthSafetyReserve: prediction.synthSafetyReserve,
    nBTCVault: prediction.nBTCVault,
    nETHVault: prediction.nETHVault,
    vaultActivationRequired: prediction.vaultActivationRequired,
    broadcasted: false,
  }, null, 2));
}
