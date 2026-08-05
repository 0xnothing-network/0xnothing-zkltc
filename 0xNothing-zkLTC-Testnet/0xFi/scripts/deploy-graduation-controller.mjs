import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { encodeDeployData, formatEther, getAddress } from "viem";

import {
  controllerAbi,
  governanceAddress,
  loadRuntime,
  pumpAbi,
  pumpRouterAbi,
  requiredAddress,
  root,
  saveRuntime,
} from "./lib/graduation-runtime.mjs";

const broadcast = process.argv.includes("--broadcast");
if (process.argv.some((argument) => argument.startsWith("--") && argument !== "--broadcast")) {
  throw new Error("Usage: npm run pump:controller:check or npm run pump:controller:deploy");
}

const runtime = loadRuntime({ wallet: true });
const { network, deployment, publicClient, walletClient, account } = runtime;
const chainId = await publicClient.getChainId();
if (chainId !== Number(network.chainId)) throw new Error(`Wrong chain: expected ${network.chainId}, received ${chainId}`);

const pump = requiredAddress(deployment.pump, "Pump");
const adapter = requiredAddress(deployment.pumpGraduationAdapter, "graduation adapter");
const router = requiredAddress(deployment.pumpGraduationRouter, "Pump router");
const governance = governanceAddress(deployment);
const guardian = requiredAddress(deployment.guardian || deployment.deployer, "guardian");
const [pumpAdmin, pumpPendingAdmin, routerAdmin, routerPendingAdmin] = await Promise.all([
  publicClient.readContract({ address: pump, abi: pumpAbi, functionName: "admin" }),
  publicClient.readContract({ address: pump, abi: pumpAbi, functionName: "pendingAdmin" }),
  publicClient.readContract({ address: router, abi: pumpRouterAbi, functionName: "admin" }),
  publicClient.readContract({ address: router, abi: pumpRouterAbi, functionName: "pendingAdmin" }),
]);

async function verifyControllerBindings(controller) {
  const code = await publicClient.getCode({ address: controller });
  if (!code || code === "0x") throw new Error("Graduation controller has no bytecode");
  const [boundPump, boundAdapter, boundRouter, boundGovernance, boundGuardian] = await Promise.all([
    publicClient.readContract({ address: controller, abi: controllerAbi, functionName: "pump" }),
    publicClient.readContract({ address: controller, abi: controllerAbi, functionName: "adapter" }),
    publicClient.readContract({ address: controller, abi: controllerAbi, functionName: "router" }),
    publicClient.readContract({ address: controller, abi: controllerAbi, functionName: "governance" }),
    publicClient.readContract({ address: controller, abi: controllerAbi, functionName: "guardian" }),
  ]);
  const bindings = [
    [boundPump, pump, "Pump"],
    [boundAdapter, adapter, "adapter"],
    [boundRouter, router, "router"],
    [boundGovernance, governance, "governance"],
    [boundGuardian, guardian, "guardian"],
  ];
  const mismatch = bindings.find(([actual, expected]) => actual.toLowerCase() !== expected.toLowerCase());
  if (mismatch) throw new Error(`Graduation controller ${mismatch[2]} binding is wrong`);
}

function recordController(controller, hash, blockNumber) {
  deployment.pumpGraduationController = controller;
  deployment.pumpGraduationControllerDeploymentBlock = blockNumber.toString();
  deployment.pumpGraduationControllerDeploymentHash = hash;
  deployment.graduationAutomationStatus = "controller-deployed-pending-activation-and-admin-handover";
  deployment.transactionHashes = [...new Set([...(deployment.transactionHashes || []), hash])];
  delete deployment.pumpGraduationControllerPendingHash;
  delete deployment.pumpGraduationControllerSubmittedAt;
  network.deployment.contracts.pumpGraduationController = controller;
  network.deployment.pumpGraduationControllerDeploymentBlock = blockNumber.toString();
  network.deployment.pumpGraduationControllerDeploymentHash = hash;
  network.deployment.graduationAutomationStatus = deployment.graduationAutomationStatus;
  saveRuntime(network, deployment);
}

const existing = deployment.pumpGraduationController
  ? requiredAddress(deployment.pumpGraduationController, "graduation controller")
  : undefined;
if (existing) {
  await verifyControllerBindings(existing);
  console.log(JSON.stringify({ mode: "existing", controller: existing, bindingsVerified: true, pumpAdmin, pumpPendingAdmin, routerAdmin, routerPendingAdmin }, null, 2));
  process.exit(0);
}

const pendingHash = deployment.pumpGraduationControllerPendingHash;
if (pendingHash) {
  const receipt = await publicClient.getTransactionReceipt({ hash: pendingHash }).catch(() => null);
  if (!receipt) {
    console.log(JSON.stringify({ mode: "pending", transactionHash: pendingHash, submittedAt: deployment.pumpGraduationControllerSubmittedAt }, null, 2));
    process.exit(0);
  }
  if (receipt.status !== "success" || !receipt.contractAddress) {
    delete deployment.pumpGraduationControllerPendingHash;
    delete deployment.pumpGraduationControllerSubmittedAt;
    saveRuntime(network, deployment);
    throw new Error(`Pending controller deployment reverted: ${pendingHash}`);
  }
  const recoveredController = getAddress(receipt.contractAddress);
  await verifyControllerBindings(recoveredController);
  recordController(recoveredController, pendingHash, receipt.blockNumber);
  console.log(JSON.stringify({ mode: "recovered", controller: recoveredController, transactionHash: pendingHash, blockNumber: receipt.blockNumber.toString(), adminTransferred: false }, null, 2));
  process.exit(0);
}

if (pumpAdmin.toLowerCase() !== account.address.toLowerCase() || routerAdmin.toLowerCase() !== account.address.toLowerCase()) {
  throw new Error("The configured wallet must still control both Pump and its graduation router before controller deployment");
}
if (pumpPendingAdmin !== "0x0000000000000000000000000000000000000000" || routerPendingAdmin !== "0x0000000000000000000000000000000000000000") {
  throw new Error("A conflicting two-step admin transfer is already pending");
}

const artifactPath = path.join(root, "contracts", "out", "PumpGraduationController.sol", "PumpGraduationController.json");
if (!fs.existsSync(artifactPath)) throw new Error("Controller artifact is missing; run npm run check:contracts first");
const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
const bytecode = artifact.bytecode?.object;
if (!/^0x[0-9a-fA-F]+$/.test(bytecode || "")) throw new Error("Controller artifact bytecode is invalid");

const deploymentData = encodeDeployData({ abi: controllerAbi, bytecode, args: [pump, adapter, governance, guardian] });
await publicClient.call({ account, data: deploymentData });
const [estimatedGas, gasPrice, balance] = await Promise.all([
  publicClient.estimateGas({ account, data: deploymentData }),
  publicClient.getGasPrice(),
  publicClient.getBalance({ address: account.address }),
]);
const estimatedCost = estimatedGas * gasPrice;
if (balance < estimatedCost + estimatedCost / 5n) throw new Error("Deployer balance is below the deployment cost plus 20% buffer");
if (!broadcast) {
  console.log(JSON.stringify({ mode: "simulation", chainId, deployer: account.address, pump, adapter, router, governance, guardian, estimatedGas: estimatedGas.toString(), estimatedCostZkLtc: formatEther(estimatedCost), deployerBalanceZkLtc: formatEther(balance), deployable: true }, null, 2));
  process.exit(0);
}

const hash = await walletClient.deployContract({ abi: controllerAbi, bytecode, args: [pump, adapter, governance, guardian], account });
deployment.pumpGraduationControllerPendingHash = hash;
deployment.pumpGraduationControllerSubmittedAt = new Date().toISOString();
saveRuntime(network, deployment);
const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
if (receipt.status !== "success" || !receipt.contractAddress) {
  delete deployment.pumpGraduationControllerPendingHash;
  delete deployment.pumpGraduationControllerSubmittedAt;
  saveRuntime(network, deployment);
  throw new Error(`Controller deployment reverted: ${hash}`);
}
const controller = getAddress(receipt.contractAddress);
await verifyControllerBindings(controller);
recordController(controller, hash, receipt.blockNumber);

console.log(JSON.stringify({ mode: "broadcast", controller, transactionHash: hash, blockNumber: receipt.blockNumber.toString(), adminTransferred: false }, null, 2));
