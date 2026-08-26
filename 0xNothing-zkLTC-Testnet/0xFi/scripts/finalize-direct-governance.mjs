import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { createPublicClient, fallback, getAddress, http, isAddress, parseAbi, zeroAddress } from "viem";

import { atomicWriteFile } from "./lib/graduation-runtime.mjs";
import { prepareMainPumpManifestUpdate, writeMainPumpManifestUpdate } from "./lib/main-pump-publication.mjs";
import { publicEnvironmentValues, writePublicEnvironment } from "./lib/public-environment.mjs";
import { fallbackRpcUrl, primaryRpcUrl, RPC_BATCH_OPTIONS } from "./lib/rpc.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });
const networkPath = path.join(root, "config", "liteforge-testnet.json");
const latestPath = path.join(root, "contracts", "deployments", "latest.json");
const predictionPath = path.join(root, "contracts", "deployments", "direct-governance.json");
const network = JSON.parse(fs.readFileSync(networkPath, "utf8"));
const deployment = JSON.parse(fs.readFileSync(latestPath, "utf8"));
const prediction = JSON.parse(fs.readFileSync(predictionPath, "utf8"));
const receiptPath = path.join(
  root,
  "contracts",
  "broadcast",
  "DisableTimelockTestnet.s.sol",
  String(network.chainId),
  "run-latest.json",
);
if (!fs.existsSync(receiptPath)) throw new Error("Direct-governance broadcast receipt is missing");

const rpcUrl = primaryRpcUrl(network);
const client = createPublicClient({
  transport: fallback([
    http(rpcUrl, { ...RPC_BATCH_OPTIONS, timeout: 15_000, retryCount: 2 }),
    http(fallbackRpcUrl(network), { ...RPC_BATCH_OPTIONS, timeout: 15_000, retryCount: 1 }),
  ]),
});
const chainId = await client.getChainId();
if (chainId !== Number(network.chainId) || Number(prediction.chainId) !== Number(network.chainId)) {
  throw new Error(`Wrong chain: expected ${network.chainId}, received ${chainId}`);
}

function address(value, label) {
  if (!isAddress(value)) throw new Error(`${label} is not a valid address`);
  return getAddress(value);
}
const deployer = address(prediction.deployer, "direct governance deployer");
const governance = address(prediction.governance, "direct governance address");
const guardian = address(prediction.guardian, "direct governance guardian");
const controller = address(prediction.pumpGraduationController, "direct governance controller");
if (governance.toLowerCase() !== deployer.toLowerCase() || guardian.toLowerCase() !== deployer.toLowerCase()) {
  throw new Error("Direct governance and guardian must both be the recorded deployer");
}
if (deployer.toLowerCase() !== address(deployment.deployer, "deployment deployer").toLowerCase()) {
  throw new Error("Direct-governance prediction belongs to a different deployer");
}

const receiptData = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
const hashes = [...new Set(
  (receiptData.transactions || [])
    .map((transaction) => transaction.hash)
    .filter((hash) => /^0x[0-9a-fA-F]{64}$/.test(hash || "")),
)];
if (!hashes.length) throw new Error("Direct-governance broadcast contains no transaction hashes");
const receipts = [];
for (const hash of hashes) {
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`Direct-governance transaction reverted: ${hash}`);
  receipts.push(receipt);
}
const deploymentBlock = receipts.reduce(
  (minimum, receipt) => receipt.blockNumber < minimum ? receipt.blockNumber : minimum,
  receipts[0].blockNumber,
);
const createReceipt = receipts.find((receipt) => receipt.contractAddress?.toLowerCase() === controller.toLowerCase());
if (!createReceipt) throw new Error("No successful controller creation receipt matches the prediction");
const verificationBlock = await client.getBlockNumber();
const readContract = (request) => client.readContract({ ...request, blockNumber: verificationBlock });
const controllerCode = await client.getCode({ address: controller, blockNumber: verificationBlock });
if (!controllerCode || controllerCode === "0x") throw new Error("Direct-governance controller has no bytecode");

const ownableAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function guardian() view returns (address)",
]);
const pumpAbi = parseAbi(["function admin() view returns (address)", "function pendingAdmin() view returns (address)"]);
const pumpRouterAbi = parseAbi([
  "function admin() view returns (address)",
  "function pendingAdmin() view returns (address)",
  "function enabled() view returns (bool)",
  "function isAdapterAllowed(address) view returns (bool)",
]);
const controllerAbi = parseAbi([
  "function pump() view returns (address)",
  "function adapter() view returns (address)",
  "function router() view returns (address)",
  "function governance() view returns (address)",
  "function guardian() view returns (address)",
  "function graduationsPaused() view returns (bool)",
]);
const timelockAbi = parseAbi(["function isOperationPending(bytes32 id) view returns (bool)"]);
const pump = address(deployment.pump, "Pump");
const pumpRouter = address(deployment.pumpGraduationRouter, "Pump router");
const adapter = address(deployment.pumpGraduationAdapter, "graduation adapter");
const legacy = deployment.legacyContracts || {};
const ownedTargets = [...new Set([
  deployment.dexFactory,
  legacy.gaugeFactory,
  legacy.nBTCVault,
  legacy.nETHVault,
  legacy.lendingPool,
  deployment.gaugeFactory,
  deployment.nBTCVault,
  deployment.nETHVault,
  deployment.lendingPool,
].filter(Boolean).map((value) => address(value, "owned target")))];
const operationIds = [...new Set([
  prediction.cancelledCoreOperationId || deployment.ownershipOperationId,
  prediction.cancelledMigrationOperationId || deployment.migrationOwnershipOperationId,
].filter(Boolean))];
const timelock = address(deployment.timelock, "legacy timelock");

const [
  owners,
  pendingOwners,
  guardians,
  pendingOperations,
  pumpAdmin,
  pumpPendingAdmin,
  routerAdmin,
  routerPendingAdmin,
  routerEnabled,
  adapterAllowed,
  boundPump,
  boundAdapter,
  boundRouter,
  boundGovernance,
  boundGuardian,
  paused,
] = await Promise.all([
  Promise.all(ownedTargets.map((target) => readContract({ address: target, abi: ownableAbi, functionName: "owner" }))),
  Promise.all(ownedTargets.map((target) => readContract({ address: target, abi: ownableAbi, functionName: "pendingOwner" }))),
  Promise.all(ownedTargets.map((target) => readContract({ address: target, abi: ownableAbi, functionName: "guardian" }))),
  Promise.all(operationIds.map((id) => readContract({ address: timelock, abi: timelockAbi, functionName: "isOperationPending", args: [id] }))),
  readContract({ address: pump, abi: pumpAbi, functionName: "admin" }),
  readContract({ address: pump, abi: pumpAbi, functionName: "pendingAdmin" }),
  readContract({ address: pumpRouter, abi: pumpRouterAbi, functionName: "admin" }),
  readContract({ address: pumpRouter, abi: pumpRouterAbi, functionName: "pendingAdmin" }),
  readContract({ address: pumpRouter, abi: pumpRouterAbi, functionName: "enabled" }),
  readContract({ address: pumpRouter, abi: pumpRouterAbi, functionName: "isAdapterAllowed", args: [adapter] }),
  readContract({ address: controller, abi: controllerAbi, functionName: "pump" }),
  readContract({ address: controller, abi: controllerAbi, functionName: "adapter" }),
  readContract({ address: controller, abi: controllerAbi, functionName: "router" }),
  readContract({ address: controller, abi: controllerAbi, functionName: "governance" }),
  readContract({ address: controller, abi: controllerAbi, functionName: "guardian" }),
  readContract({ address: controller, abi: controllerAbi, functionName: "graduationsPaused" }),
]);
if (owners.some((owner) => owner.toLowerCase() !== deployer.toLowerCase())) throw new Error("Direct owner verification failed");
if (pendingOwners.some((pendingOwner) => pendingOwner.toLowerCase() !== zeroAddress)) throw new Error("A pending owner remains");
if (guardians.some((currentGuardian) => currentGuardian.toLowerCase() !== guardian.toLowerCase())) {
  throw new Error("Direct guardian verification failed");
}
if (pendingOperations.some(Boolean)) throw new Error("A legacy timelock operation remains pending");
for (const [actual, expected, label] of [
  [pumpAdmin, controller, "Pump admin"],
  [routerAdmin, controller, "router admin"],
  [boundPump, pump, "controller Pump"],
  [boundAdapter, adapter, "controller adapter"],
  [boundRouter, pumpRouter, "controller router"],
  [boundGovernance, governance, "controller governance"],
  [boundGuardian, guardian, "controller guardian"],
]) {
  if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`${label} mismatch`);
}
if (pumpPendingAdmin.toLowerCase() !== zeroAddress || routerPendingAdmin.toLowerCase() !== zeroAddress) {
  throw new Error("A Pump admin transfer remains pending");
}
if (!routerEnabled || !adapterAllowed || paused) throw new Error("Graduation controller is not operational");

const finalizedAt = new Date().toISOString();
Object.assign(deployment, {
  status: "direct-governance-no-timelock",
  governanceMode: "direct-deployer-no-timelock",
  governance,
  guardian,
  coreOwnershipStatus: "direct-deployer-owner-no-pending",
  pumpGraduationController: controller,
  pumpGraduationControllerDeploymentBlock: createReceipt.blockNumber.toString(),
  pumpGraduationControllerDeploymentHash: createReceipt.transactionHash,
  graduationAutomationStatus: "active-permissionless",
  graduationControllerGovernance: governance,
  pumpAdministrationStatus: "controller-admin-active",
  directGovernanceMigrationStatus: "finalized",
  graduationAutomationActivatedAt: finalizedAt,
  directGovernanceMigrationBlock: deploymentBlock.toString(),
  graduationLastVerifiedBlock: verificationBlock.toString(),
  directGovernanceMigrationHashes: hashes,
  directGovernanceFinalizedAt: finalizedAt,
  cancelledOwnershipOperationIds: operationIds,
  transactionHashes: [...new Set([...(deployment.transactionHashes || []), ...hashes])],
});
delete deployment.pendingGovernance;
Object.assign(network.deployment, {
  status: deployment.status,
  governanceMode: deployment.governanceMode,
  governance,
  guardian,
  coreOwnershipStatus: deployment.coreOwnershipStatus,
  graduationAutomationStatus: deployment.graduationAutomationStatus,
  graduationControllerGovernance: governance,
  pumpAdministrationStatus: deployment.pumpAdministrationStatus,
  directGovernanceMigrationStatus: deployment.directGovernanceMigrationStatus,
  directGovernanceMigrationBlock: deployment.directGovernanceMigrationBlock,
  graduationLastVerifiedBlock: deployment.graduationLastVerifiedBlock,
  pumpGraduationControllerDeploymentBlock: deployment.pumpGraduationControllerDeploymentBlock,
  pumpGraduationControllerDeploymentHash: deployment.pumpGraduationControllerDeploymentHash,
  directGovernanceFinalizedAt: finalizedAt,
});
delete network.deployment.pendingGovernance;
network.deployment.contracts.pumpGraduationController = controller;

// Validate every projected public value before any manifest is replaced.
publicEnvironmentValues({ deployment, network, rpcUrl });
const mainPumpManifestUpdate = prepareMainPumpManifestUpdate({
  root,
  chainId: network.chainId,
  pump,
  router: pumpRouter,
  adapter,
  controller,
  governance,
  guardian,
  controllerDeploymentBlock: createReceipt.blockNumber,
  controllerDeploymentHash: createReceipt.transactionHash,
  verificationBlock,
  activatedAt: finalizedAt,
});
atomicWriteFile(latestPath, `${JSON.stringify(deployment, null, 2)}\n`);
atomicWriteFile(networkPath, `${JSON.stringify(network, null, 2)}\n`);
writePublicEnvironment({ root, deployment, network, rpcUrl });
writeMainPumpManifestUpdate(mainPumpManifestUpdate);
console.log(JSON.stringify({
  status: deployment.status,
  governanceMode: deployment.governanceMode,
  governance,
  guardian,
  controller,
  migrationBlock: deployment.directGovernanceMigrationBlock,
  transactionHashes: hashes,
}, null, 2));
