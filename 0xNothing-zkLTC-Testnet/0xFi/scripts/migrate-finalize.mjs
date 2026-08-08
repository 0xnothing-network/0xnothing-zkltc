#!/usr/bin/env node
/**
 * Post-broadcast finalizer for MigrateRemoveGuard
 *
 * Reads contracts/deployments/guard-removal.json (prediction from dry-run),
 * verifies every on-chain receipt, bytecode, pair/gauge binding, ownership,
 * and old-vault withdrawal, then atomically updates:
 *  - contracts/deployments/latest.json
 *  - config/liteforge-testnet.json
 *  - subgraph/subgraph.config.json
 *  - ../apps/web/.env.local
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import {
  createPublicClient,
  fallback,
  getAddress,
  http,
  isAddress,
  parseAbi,
  zeroAddress,
} from "viem";

import { atomicWriteFile } from "./lib/graduation-runtime.mjs";
import {
  creationInputMatchesArtifact,
  CURRENT_LENDING_IMPLEMENTATION_STATUS,
  LEGACY_LENDING_IMPLEMENTATION_STATUS,
  LENDING_IMPLEMENTATION_REQUIRED_ACTION,
} from "./lib/lending-implementation.mjs";
import { writePublicEnvironment } from "./lib/public-environment.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });

const rpcUrl = (process.env.LITEFORGE_RPC_URL || "https://liteforge.rpc.caldera.xyz/infra-partner-http").trim();
const fallbackUrl = (process.env.LITEFORGE_FALLBACK_RPC_URL || "https://liteforge.rpc.caldera.xyz/http").trim();
const client = createPublicClient({ transport: fallback([http(rpcUrl), http(fallbackUrl)]) });

const CHAIN_ID = 4441;
const predPath = path.join(root, "contracts", "deployments", "guard-removal.json");
const latestPath = path.join(root, "contracts", "deployments", "latest.json");
const networkPath = path.join(root, "config", "liteforge-testnet.json");
const subgraphConfigPath = path.join(root, "subgraph", "subgraph.config.json");
const broadcastPath = path.join(root, "contracts", "broadcast",
  "MigrateRemoveGuard.s.sol", String(CHAIN_ID), "run-latest.json");

if (!fs.existsSync(predPath)) throw new Error("guard-removal.json not found — run dry-run first");
if (!fs.existsSync(broadcastPath)) throw new Error("broadcast receipt not found — must broadcast first");

const pred = JSON.parse(fs.readFileSync(predPath, "utf8"));
const previous = JSON.parse(fs.readFileSync(latestPath, "utf8"));
const legacySnapshot = previous.legacyContracts || previous;
const network = JSON.parse(fs.readFileSync(networkPath, "utf8"));

if (!pred.broadcasted) {
  console.warn("WARNING: guard-removal.json says broadcasted=false — verifying anyway from broadcast receipt");
}

const chainId = await client.getChainId();
if (chainId !== CHAIN_ID) throw new Error(`Wrong chain: expected ${CHAIN_ID}, got ${chainId}`);

// --- Load broadcast receipts and get minimum deployment block ---------------
console.log("Loading broadcast receipts …");
const broadcastData = JSON.parse(fs.readFileSync(broadcastPath, "utf8"));
const lendingCreates = (broadcastData.transactions || []).filter((transaction) => (
  transaction.transactionType === "CREATE" && transaction.contractName === "PooledNUSDLendingPool"
));
if (lendingCreates.length !== 1) {
  throw new Error("Broadcast journal must contain exactly one lending-pool creation");
}
const lendingArtifactPath = path.join(
  root,
  "contracts",
  "out",
  "PooledNUSDLendingPool.sol",
  "PooledNUSDLendingPool.json",
);
if (!fs.existsSync(lendingArtifactPath)) throw new Error("Current lending artifact is missing; run the contract build");
const lendingArtifact = JSON.parse(fs.readFileSync(lendingArtifactPath, "utf8"));
const lendingMatchesCurrentArtifact = creationInputMatchesArtifact(
  lendingCreates[0].transaction?.input,
  lendingArtifact.bytecode?.object,
);
const hashes = [...new Set(
  (broadcastData.transactions || [])
    .map((tx) => tx.hash)
    .filter((h) => /^0x[0-9a-fA-F]{64}$/.test(h || "")),
)];
if (hashes.length === 0) throw new Error("No transaction hashes in broadcast file");

const receipts = [];
for (const hash of hashes) {
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`Migration transaction reverted: ${hash}`);
  receipts.push(receipt);
}
const deploymentBlock = receipts.reduce(
  (min, r) => r.blockNumber < min ? r.blockNumber : min,
  receipts[0].blockNumber,
);
console.log(`All ${hashes.length} receipts confirmed. Deployment block: ${deploymentBlock}`);

// --- Address helper ----------------------------------------------------------
function req(value, label) {
  if (!isAddress(value)) throw new Error(`${label} is not a valid address in prediction`);
  return getAddress(value);
}

const addr = {
  gaugeFactory: req(pred.gaugeFactory, "gaugeFactory"),
  nBTC:         req(pred.nBTC, "nBTC"),
  nETH:         req(pred.nETH, "nETH"),
  nBTCVault:    req(pred.nBTCVault, "nBTCVault"),
  nETHVault:    req(pred.nETHVault, "nETHVault"),
  lendingPool:  req(pred.lendingPool, "lendingPool"),
  nBTCNusdPair: req(pred.nBTCNusdPair, "nBTCNusdPair"),
  nETHNusdPair: req(pred.nETHNusdPair, "nETHNusdPair"),
  wzkLtcNusdGauge: req(pred.wzkLtcNusdGauge, "wzkLtcNusdGauge"),
  nBTCNusdGauge:   req(pred.nBTCNusdGauge, "nBTCNusdGauge"),
  nETHNusdGauge:   req(pred.nETHNusdGauge, "nETHNusdGauge"),
  // inherited from previous deployment
  nusd:     req(previous.nusd, "nusd"),
  wzkLTC:   req(previous.wzkLTC, "wzkLTC"),
  timelock: req(previous.timelock, "timelock"),
  dexFactory: req(previous.dexFactory, "dexFactory"),
  dexRouter:  req(previous.dexRouter, "dexRouter"),
  pumpGraduationAdapter: req(previous.pumpGraduationAdapter, "pumpGraduationAdapter"),
  pumpGraduationController: req(previous.pumpGraduationController, "pumpGraduationController"),
  pump: req(previous.pump, "pump"),
  ltcOracle: req(previous.ltcOracle, "ltcOracle"),
  btcOracle: req(previous.btcOracle, "btcOracle"),
  ethOracle: req(previous.ethOracle, "ethOracle"),
  wzkLtcNusdPair: req(previous.wzkLtcNusdPair, "wzkLtcNusdPair"),
};
const legacy = {
  gaugeFactory: req(legacySnapshot.gaugeFactory, "legacy gaugeFactory"),
  nBTC: req(legacySnapshot.nBTC, "legacy nBTC"),
  nETH: req(legacySnapshot.nETH, "legacy nETH"),
  nBTCVault: req(legacySnapshot.nBTCVault, "legacy nBTCVault"),
  nETHVault: req(legacySnapshot.nETHVault, "legacy nETHVault"),
  lendingPool: req(legacySnapshot.lendingPool, "legacy lendingPool"),
  nBTCNusdPair: req(legacySnapshot.nBTCNusdPair, "legacy nBTCNusdPair"),
  nETHNusdPair: req(legacySnapshot.nETHNusdPair, "legacy nETHNusdPair"),
  wzkLtcNusdGauge: req(legacySnapshot.wzkLtcNusdGauge, "legacy wzkLtcNusdGauge"),
  nBTCNusdGauge: req(legacySnapshot.nBTCNusdGauge, "legacy nBTCNusdGauge"),
  nETHNusdGauge: req(legacySnapshot.nETHNusdGauge, "legacy nETHNusdGauge"),
};

// --- Verify bytecode at every new address -----------------------------------
console.log("Verifying bytecode …");
const newAddresses = [
  addr.gaugeFactory, addr.nBTC, addr.nETH, addr.nBTCVault, addr.nETHVault,
  addr.lendingPool, addr.nBTCNusdPair, addr.nETHNusdPair,
  addr.wzkLtcNusdGauge, addr.nBTCNusdGauge, addr.nETHNusdGauge,
];
await Promise.all(newAddresses.map(async (a) => {
  const code = await client.getCode({ address: a });
  if (!code || code === "0x") throw new Error(`No bytecode at ${a}`);
}));
console.log("  All 11 new contracts have bytecode ✓");

// --- Verify pair + gauge bindings -------------------------------------------
const factoryAbi = parseAbi([
  "function getPair(address,address) view returns (address)",
  "function isPair(address) view returns (bool)",
]);
const gaugeFactoryAbi = parseAbi(["function gaugeForPair(address) view returns (address)"]);
const synthAbi = parseAbi(["function owner() view returns (address)", "function vault() view returns (address)"]);
const ownableAbi = parseAbi(["function owner() view returns (address)", "function pendingOwner() view returns (address)"]);
const vaultAbi = parseAbi([
  "function oracle() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function totalCollateralNusd() view returns (uint256)",
  "function totalDebtSynthetic() view returns (uint256)",
  "function totalBadDebtSynthetic() view returns (uint256)",
]);
const lendingAbi = parseAbi([
  "function pendingOwner() view returns (address)",
  "function collateralConfigs(address) view returns (address,uint256,uint16,uint16,uint16,uint8,bool)",
  "function totalSupplied() view returns (uint256)",
  "function totalBorrowed() view returns (uint256)",
  "function totalBadDebtNusd() view returns (uint256)",
  "function totalCollateralByAsset(address) view returns (uint256)",
]);
const timelockAbi = parseAbi(["function getTimestamp(bytes32 id) view returns (uint256)"]);
const erc20Abi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const gaugeAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function totalFunded() view returns (uint256)",
  "function totalPaid() view returns (uint256)",
]);

console.log("Verifying bindings …");
const [nBTCPair, nETHPair, wzkLtcGaugeFor, nBTCGaugeFor, nETHGaugeFor,
       nBTCOwner, nETHOwner, nBTCVaultAddr, nETHVaultAddr,
       gaugeFactoryPending, nBTCVaultPending, nETHVaultPending, lendingPending,
       migrationOwnershipReadyAt] = await Promise.all([
  client.readContract({ address: addr.dexFactory, abi: factoryAbi, functionName: "getPair", args: [addr.nBTC, addr.nusd] }),
  client.readContract({ address: addr.dexFactory, abi: factoryAbi, functionName: "getPair", args: [addr.nETH, addr.nusd] }),
  client.readContract({ address: addr.gaugeFactory, abi: gaugeFactoryAbi, functionName: "gaugeForPair", args: [addr.wzkLtcNusdPair] }),
  client.readContract({ address: addr.gaugeFactory, abi: gaugeFactoryAbi, functionName: "gaugeForPair", args: [addr.nBTCNusdPair] }),
  client.readContract({ address: addr.gaugeFactory, abi: gaugeFactoryAbi, functionName: "gaugeForPair", args: [addr.nETHNusdPair] }),
  client.readContract({ address: addr.nBTC, abi: synthAbi, functionName: "owner" }),
  client.readContract({ address: addr.nETH, abi: synthAbi, functionName: "owner" }),
  client.readContract({ address: addr.nBTC, abi: synthAbi, functionName: "vault" }),
  client.readContract({ address: addr.nETH, abi: synthAbi, functionName: "vault" }),
  client.readContract({ address: addr.gaugeFactory, abi: ownableAbi, functionName: "pendingOwner" }),
  client.readContract({ address: addr.nBTCVault, abi: vaultAbi, functionName: "pendingOwner" }),
  client.readContract({ address: addr.nETHVault, abi: vaultAbi, functionName: "pendingOwner" }),
  client.readContract({ address: addr.lendingPool, abi: lendingAbi, functionName: "pendingOwner" }),
  client.readContract({ address: addr.timelock, abi: timelockAbi, functionName: "getTimestamp",
    args: [pred.ownershipOperationId] }),
]);

if (getAddress(nBTCPair) !== addr.nBTCNusdPair)
  throw new Error(`nBTC/NUSD pair mismatch: expected ${addr.nBTCNusdPair}, got ${nBTCPair}`);
if (getAddress(nETHPair) !== addr.nETHNusdPair)
  throw new Error(`nETH/NUSD pair mismatch: expected ${addr.nETHNusdPair}, got ${nETHPair}`);
if (getAddress(wzkLtcGaugeFor) !== addr.wzkLtcNusdGauge)
  throw new Error(`wzkLTC gauge mismatch: expected ${addr.wzkLtcNusdGauge}, got ${wzkLtcGaugeFor}`);
if (getAddress(nBTCGaugeFor) !== addr.nBTCNusdGauge)
  throw new Error(`nBTC gauge mismatch: expected ${addr.nBTCNusdGauge}, got ${nBTCGaugeFor}`);
if (getAddress(nETHGaugeFor) !== addr.nETHNusdGauge)
  throw new Error(`nETH gauge mismatch: expected ${addr.nETHNusdGauge}, got ${nETHGaugeFor}`);
if (nBTCOwner.toLowerCase() !== zeroAddress)
  throw new Error(`nBTC asset owner should be 0x0, got ${nBTCOwner}`);
if (nETHOwner.toLowerCase() !== zeroAddress)
  throw new Error(`nETH asset owner should be 0x0, got ${nETHOwner}`);
if (getAddress(nBTCVaultAddr) !== addr.nBTCVault)
  throw new Error(`nBTC vault binding mismatch`);
if (getAddress(nETHVaultAddr) !== addr.nETHVault)
  throw new Error(`nETH vault binding mismatch`);
if (gaugeFactoryPending.toLowerCase() !== addr.timelock.toLowerCase())
  throw new Error(`gaugeFactory pendingOwner must be timelock`);
if (nBTCVaultPending.toLowerCase() !== addr.timelock.toLowerCase())
  throw new Error(`nBTC vault pendingOwner must be timelock`);
if (nETHVaultPending.toLowerCase() !== addr.timelock.toLowerCase())
  throw new Error(`nETH vault pendingOwner must be timelock`);
if (lendingPending.toLowerCase() !== addr.timelock.toLowerCase())
  throw new Error(`lendingPool pendingOwner must be timelock`);
if (migrationOwnershipReadyAt === 0n)
  throw new Error(`Migration ownership operation not scheduled in timelock`);
console.log("  All bindings + ownership schedule verified ✓");

// --- Verify old vault was emptied -------------------------------------------
console.log("Verifying old vaults empty …");
const [oldNbtcCollateral, oldNbtcDebt, oldNbtcLp, oldNethCollateral, oldNethLp] = await Promise.all([
  client.readContract({ address: getAddress(legacySnapshot.nBTCVault), abi: vaultAbi, functionName: "totalCollateralNusd" }),
  client.readContract({ address: getAddress(legacySnapshot.nBTCVault), abi: vaultAbi, functionName: "totalDebtSynthetic" }),
  client.readContract({ address: legacy.nBTCNusdPair, abi: erc20Abi, functionName: "totalSupply" }),
  client.readContract({ address: getAddress(legacySnapshot.nETHVault), abi: vaultAbi, functionName: "totalCollateralNusd" }),
  client.readContract({ address: legacy.nETHNusdPair, abi: erc20Abi, functionName: "totalSupply" }),
]);
if (oldNbtcCollateral !== 0n || oldNbtcDebt !== 0n)
  throw new Error(`Old nBTC vault still has funds: collateral=${oldNbtcCollateral}, debt=${oldNbtcDebt}`);
if (oldNethCollateral !== 0n)
  throw new Error(`Old nETH vault still has funds: collateral=${oldNethCollateral}`);
if (oldNbtcLp !== 0n)
  throw new Error(`Old nBTC/NUSD pair has LP supply ${oldNbtcLp} — unexpected`);
if (oldNethLp !== 0n)
  throw new Error(`Old nETH/NUSD pair has LP supply ${oldNethLp} — unexpected`);
console.log("  Old vaults and pairs empty ✓");

// Re-check the complete legacy safety boundary. The migration transaction did
// this before deploying replacements; the finalizer must independently prove
// the same state before publishing new addresses.
const read = (address, abi, functionName, args = []) => client.readContract({
  address,
  abi,
  functionName,
  args,
});
const legacyChecks = [
  ["nBTC vault collateral", read(legacy.nBTCVault, vaultAbi, "totalCollateralNusd")],
  ["nBTC vault debt", read(legacy.nBTCVault, vaultAbi, "totalDebtSynthetic")],
  ["nBTC vault bad debt", read(legacy.nBTCVault, vaultAbi, "totalBadDebtSynthetic")],
  ["nETH vault collateral", read(legacy.nETHVault, vaultAbi, "totalCollateralNusd")],
  ["nETH vault debt", read(legacy.nETHVault, vaultAbi, "totalDebtSynthetic")],
  ["nETH vault bad debt", read(legacy.nETHVault, vaultAbi, "totalBadDebtSynthetic")],
  ["legacy nBTC supply", read(legacy.nBTC, erc20Abi, "totalSupply")],
  ["legacy nETH supply", read(legacy.nETH, erc20Abi, "totalSupply")],
  ["legacy lending supply", read(legacy.lendingPool, lendingAbi, "totalSupplied")],
  ["legacy lending debt", read(legacy.lendingPool, lendingAbi, "totalBorrowed")],
  ["legacy lending bad debt", read(legacy.lendingPool, lendingAbi, "totalBadDebtNusd")],
  ["legacy lending WzkLTC collateral", read(legacy.lendingPool, lendingAbi, "totalCollateralByAsset", [addr.wzkLTC])],
  ["legacy lending nBTC collateral", read(legacy.lendingPool, lendingAbi, "totalCollateralByAsset", [legacy.nBTC])],
  ["legacy lending nETH collateral", read(legacy.lendingPool, lendingAbi, "totalCollateralByAsset", [legacy.nETH])],
];
for (const [symbol, gauge] of [
  ["WzkLTC", legacy.wzkLtcNusdGauge],
  ["nBTC", legacy.nBTCNusdGauge],
  ["nETH", legacy.nETHNusdGauge],
]) {
  legacyChecks.push(
    [`legacy ${symbol} gauge shares`, read(gauge, gaugeAbi, "totalSupply")],
    [`legacy ${symbol} gauge funded rewards`, read(gauge, gaugeAbi, "totalFunded")],
    [`legacy ${symbol} gauge paid rewards`, read(gauge, gaugeAbi, "totalPaid")],
    [`legacy ${symbol} gauge NUSD balance`, read(addr.nusd, erc20Abi, "balanceOf", [gauge])],
  );
}
for (const [symbol, pair, asset] of [
  ["nBTC", legacy.nBTCNusdPair, legacy.nBTC],
  ["nETH", legacy.nETHNusdPair, legacy.nETH],
]) {
  legacyChecks.push(
    [`legacy ${symbol}/NUSD LP supply`, read(pair, erc20Abi, "totalSupply")],
    [`legacy ${symbol}/NUSD NUSD balance`, read(addr.nusd, erc20Abi, "balanceOf", [pair])],
    [`legacy ${symbol}/NUSD asset balance`, read(asset, erc20Abi, "balanceOf", [pair])],
  );
}
const legacyValues = await Promise.all(legacyChecks.map(([, request]) => request));
const nonEmptyLegacyState = legacyChecks
  .map(([label], index) => [label, legacyValues[index]])
  .filter(([, value]) => value !== 0n);
if (nonEmptyLegacyState.length) {
  throw new Error(
    `Legacy state is not empty: ${nonEmptyLegacyState.map(([label, value]) => `${label}=${value}`).join(", ")}`,
  );
}

// --- Write updated manifests ------------------------------------------------
console.log("Updating manifests …");

const now = new Date().toISOString();
const lendingImplementationStatus = lendingMatchesCurrentArtifact
  ? CURRENT_LENDING_IMPLEMENTATION_STATUS
  : LEGACY_LENDING_IMPLEMENTATION_STATUS;
const lendingImplementationMigrationRequired = !lendingMatchesCurrentArtifact;
const newDeployment = {
  ...previous,
  broadcasted: true,
  status: "deployed-pending-activation-no-guard",
  migrationBroadcastedAt: now,
  migrationHashes: hashes,
  migrationDeploymentBlock: String(deploymentBlock),
  migrationOwnershipOperationId: pred.ownershipOperationId,
  migrationOwnershipReadyAt: String(migrationOwnershipReadyAt),
  legacyContracts: previous.legacyContracts || {
    gaugeFactory: previous.gaugeFactory,
    nBTC: previous.nBTC,
    nETH: previous.nETH,
    nBTCVault: previous.nBTCVault,
    nETHVault: previous.nETHVault,
    lendingPool: previous.lendingPool,
    nBTCNusdPair: previous.nBTCNusdPair,
    nETHNusdPair: previous.nETHNusdPair,
    wzkLtcNusdGauge: previous.wzkLtcNusdGauge,
    nBTCNusdGauge: previous.nBTCNusdGauge,
    nETHNusdGauge: previous.nETHNusdGauge,
  },
  // new contract addresses
  gaugeFactory: addr.gaugeFactory,
  nBTC: addr.nBTC,
  nETH: addr.nETH,
  nBTCVault: addr.nBTCVault,
  nETHVault: addr.nETHVault,
  lendingPool: addr.lendingPool,
  nBTCNusdPair: addr.nBTCNusdPair,
  nETHNusdPair: addr.nETHNusdPair,
  wzkLtcNusdGauge: addr.wzkLtcNusdGauge,
  nBTCNusdGauge: addr.nBTCNusdGauge,
  nETHNusdGauge: addr.nETHNusdGauge,
  riskMode: "caps-pauses-oracles-no-nusd-health-guard",
  // clear stale guard state from the previous deployment
  nusdHealthGuard: undefined,
  nusdHealth: undefined,
  lendingCollateralConfigurationStatus: "configured-three-assets-oracle-only",
  lendingImplementationStatus,
  lendingImplementationMigrationRequired,
  lendingImplementationRequiredAction: lendingImplementationMigrationRequired
    ? LENDING_IMPLEMENTATION_REQUIRED_ACTION
    : undefined,
  contracts: {
    ...previous.contracts,
    gaugeFactory: addr.gaugeFactory,
    nBTC: addr.nBTC,
    nETH: addr.nETH,
    nBTCVault: addr.nBTCVault,
    nETHVault: addr.nETHVault,
    lendingPool: addr.lendingPool,
    nBTCNusdPair: addr.nBTCNusdPair,
    nETHNusdPair: addr.nETHNusdPair,
    wzkLtcNusdGauge: addr.wzkLtcNusdGauge,
    nBTCNusdGauge: addr.nBTCNusdGauge,
    nETHNusdGauge: addr.nETHNusdGauge,
  },
};
// Remove undefined fields
for (const key of Object.keys(newDeployment)) {
  if (newDeployment[key] === undefined) delete newDeployment[key];
}
atomicWriteFile(latestPath, `${JSON.stringify(newDeployment, null, 2)}\n`);
console.log("  contracts/deployments/latest.json ✓");

// Update network config
network.deployment = {
  ...network.deployment,
  status: "deployed-pending-activation-no-guard",
  migrationDeploymentBlock: String(deploymentBlock),
  migrationOwnershipOperationId: pred.ownershipOperationId,
  migrationOwnershipReadyAt: String(migrationOwnershipReadyAt),
  migrationBroadcastedAt: now,
  contracts: {
    ...network.deployment.contracts,
    gaugeFactory: addr.gaugeFactory,
    nBTC: addr.nBTC,
    nETH: addr.nETH,
    nBTCVault: addr.nBTCVault,
    nETHVault: addr.nETHVault,
    lendingPool: addr.lendingPool,
    nBTCNusdPair: addr.nBTCNusdPair,
    nETHNusdPair: addr.nETHNusdPair,
    wzkLtcNusdGauge: addr.wzkLtcNusdGauge,
    nBTCNusdGauge: addr.nBTCNusdGauge,
    nETHNusdGauge: addr.nETHNusdGauge,
  },
  riskMode: "caps-pauses-oracles-no-nusd-health-guard",
  lendingCollateralConfigurationStatus: "configured-three-assets-oracle-only",
  lendingImplementationStatus,
  lendingImplementationMigrationRequired,
  ...(lendingImplementationMigrationRequired
    ? { lendingImplementationRequiredAction: LENDING_IMPLEMENTATION_REQUIRED_ACTION }
    : {}),
};
// Remove old guard from network config
if (network.deployment.contracts) delete network.deployment.contracts.nusdHealthGuard;
if (network.nusdGuard) delete network.nusdGuard;
atomicWriteFile(networkPath, `${JSON.stringify(network, null, 2)}\n`);
console.log("  config/liteforge-testnet.json ✓");

// Update subgraph config. The DEX factory is NOT redeployed, so startBlock must
// stay at the original deployment block or the entire PairCreated history for the
// canonical wzkLTC/NUSD pair is dropped. The subgraph template applies one
// __START_BLOCK__ to every data source; the new gauge/vault/lending contracts have
// no events before the migration block, so indexing them from the original block is
// harmless (a small extra scan) and keeps factory history intact.
const subgraphConfig = JSON.parse(fs.readFileSync(subgraphConfigPath, "utf8"));
subgraphConfig.gaugeFactoryAddress = addr.gaugeFactory;
subgraphConfig.nbtcVaultAddress = addr.nBTCVault;
subgraphConfig.nethVaultAddress = addr.nETHVault;
subgraphConfig.lendingPoolAddress = addr.lendingPool;
// startBlock intentionally left unchanged (original factory deployment block).
atomicWriteFile(subgraphConfigPath, `${JSON.stringify(subgraphConfig, null, 2)}\n`);
console.log("  subgraph/subgraph.config.json ✓ (startBlock preserved at original factory block)");

// Materialize every public address from the verified manifest. This removes
// legacy aliases and clears stale optional values from an older deployment.
writePublicEnvironment({ root, deployment: newDeployment, network, rpcUrl });
console.log("  ../apps/web/.env.local ✓");

console.log(`
Migration finalized successfully.
  New deployment block : ${deploymentBlock}
  New gaugeFactory     : ${addr.gaugeFactory}
  New nBTC             : ${addr.nBTC}
  New nETH             : ${addr.nETH}
  New lendingPool      : ${addr.lendingPool}
  New nBTCNusdPair     : ${addr.nBTCNusdPair}
  New nETHNusdPair     : ${addr.nETHNusdPair}
  Ownership ready at   : ${new Date(Number(migrationOwnershipReadyAt) * 1000).toISOString()}

Next steps:
  1. npm run check:subgraph            (verify subgraph builds with new addresses)
  2. npm run check:web                 (rebuild web with new env)
  3. npm --workspace subgraph run deploy (redeploy Goldsky subgraph)
  4. Wait for timelock (~48h) then: npm run activate:core
`);
