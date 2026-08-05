import process from "node:process";

import {
  controllerAbi,
  governanceAddress,
  governanceMode,
  loadRuntime,
  pumpAbi,
  pumpRouterAbi,
  requiredAddress,
  saveRuntime,
  sendContract,
} from "./lib/graduation-runtime.mjs";

const broadcast = process.argv.includes("--broadcast");
if (process.argv.some((argument) => argument.startsWith("--") && argument !== "--broadcast")) {
  throw new Error("Usage: npm run pump:automation:check or npm run pump:automation:activate");
}

const runtime = loadRuntime({ wallet: true });
const { deployment, network, publicClient, account } = runtime;
const chainId = await publicClient.getChainId();
if (chainId !== Number(network.chainId)) {
  throw new Error(`Wrong chain: expected ${network.chainId}, received ${chainId}`);
}
const pump = requiredAddress(deployment.pump, "Pump");
const router = requiredAddress(deployment.pumpGraduationRouter, "Pump router");
const adapter = requiredAddress(deployment.pumpGraduationAdapter, "graduation adapter");
const controller = requiredAddress(deployment.pumpGraduationController, "graduation controller");
const governance = governanceAddress(deployment);
const mode = governanceMode(deployment);
const ownableAbi = [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] }];

const controllerCode = await publicClient.getCode({ address: controller });
if (!controllerCode || controllerCode === "0x") throw new Error("Graduation controller has no bytecode");
const [boundPump, boundAdapter, boundRouter, boundGovernance] = await Promise.all([
  publicClient.readContract({ address: controller, abi: controllerAbi, functionName: "pump" }),
  publicClient.readContract({ address: controller, abi: controllerAbi, functionName: "adapter" }),
  publicClient.readContract({ address: controller, abi: controllerAbi, functionName: "router" }),
  publicClient.readContract({ address: controller, abi: controllerAbi, functionName: "governance" }),
]);
if (
  boundPump.toLowerCase() !== pump.toLowerCase()
  || boundAdapter.toLowerCase() !== adapter.toLowerCase()
  || boundRouter.toLowerCase() !== router.toLowerCase()
  || boundGovernance.toLowerCase() !== governance.toLowerCase()
) throw new Error("Graduation controller bindings do not match the deployment manifest");

let [pumpAdmin, pumpPendingAdmin, routerAdmin, routerPendingAdmin, routerEnabled, adapterAllowed, enableAt, adapterAt] = await Promise.all([
  publicClient.readContract({ address: pump, abi: pumpAbi, functionName: "admin" }),
  publicClient.readContract({ address: pump, abi: pumpAbi, functionName: "pendingAdmin" }),
  publicClient.readContract({ address: router, abi: pumpRouterAbi, functionName: "admin" }),
  publicClient.readContract({ address: router, abi: pumpRouterAbi, functionName: "pendingAdmin" }),
  publicClient.readContract({ address: router, abi: pumpRouterAbi, functionName: "enabled" }),
  publicClient.readContract({ address: router, abi: pumpRouterAbi, functionName: "isAdapterAllowed", args: [adapter] }),
  publicClient.readContract({ address: router, abi: pumpRouterAbi, functionName: "enableAt" }),
  publicClient.readContract({ address: router, abi: pumpRouterAbi, functionName: "adapterActivationTime", args: [adapter] }),
]);
const block = await publicClient.getBlock();
if (!routerEnabled && enableAt === 0n) {
  if (!broadcast) {
    console.log(JSON.stringify({ mode: "check", ready: false, controller, reason: "Router enable has not been scheduled" }, null, 2));
    process.exitCode = 1;
    process.exit();
  }
  throw new Error("Router enable has not been scheduled");
}
if (!adapterAllowed && adapterAt === 0n) {
  if (!broadcast) {
    console.log(JSON.stringify({ mode: "check", ready: false, controller, reason: "Graduation adapter activation has not been scheduled" }, null, 2));
    process.exitCode = 1;
    process.exit();
  }
  throw new Error("Graduation adapter activation has not been scheduled");
}
const readiness = [
  !routerEnabled && block.timestamp < enableAt ? ["router", enableAt] : undefined,
  !adapterAllowed && block.timestamp < adapterAt ? ["adapter", adapterAt] : undefined,
].filter(Boolean);
if (readiness.length) {
  const [name, timestamp] = readiness.sort((left, right) => Number(right[1] - left[1]))[0];
  if (!broadcast) {
    console.log(JSON.stringify({ mode: "check", ready: false, controller, reason: `${name} activation delay is not ready`, readyAt: new Date(Number(timestamp) * 1000).toISOString(), remainingSeconds: (timestamp - block.timestamp).toString() }, null, 2));
    process.exitCode = 1;
    process.exit();
  }
  throw new Error(`${name} timelock is not ready until ${new Date(Number(timestamp) * 1000).toISOString()}`);
}

const governedTargets = [
  deployment.dexFactory,
  deployment.gaugeFactory,
  deployment.nBTCVault,
  deployment.nETHVault,
  deployment.lendingPool,
].map((address, index) => requiredAddress(address, `governed target ${index + 1}`));
const governedOwners = await Promise.all(governedTargets.map((address) => publicClient.readContract({
  address,
  abi: ownableAbi,
  functionName: "owner",
})));
const governedPendingOwners = await Promise.all(governedTargets.map((address) => publicClient.readContract({
  address,
  abi: [{ type: "function", name: "pendingOwner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
  functionName: "pendingOwner",
})));
const zero = "0x0000000000000000000000000000000000000000";
const coreOwnershipComplete = governedOwners.every((owner) => owner.toLowerCase() === governance.toLowerCase())
  && governedPendingOwners.every((pendingOwner) => pendingOwner.toLowerCase() === zero);
if (!coreOwnershipComplete) {
  if (!broadcast) {
    console.log(JSON.stringify({ mode: "check", ready: false, controller, governanceMode: mode, reason: "Core 0xFi ownership state is incomplete" }, null, 2));
    process.exitCode = 1;
    process.exit();
  }
  throw new Error("Complete core 0xFi ownership activation before graduation admin handover");
}

const allowedAdmins = new Set([account.address.toLowerCase(), controller.toLowerCase()]);
if (!allowedAdmins.has(pumpAdmin.toLowerCase()) || !allowedAdmins.has(routerAdmin.toLowerCase())) {
  throw new Error("Pump or router admin is neither the deployer nor the recorded controller");
}
for (const [pending, label] of [[pumpPendingAdmin, "Pump"], [routerPendingAdmin, "router"]]) {
  if (pending !== "0x0000000000000000000000000000000000000000" && pending.toLowerCase() !== controller.toLowerCase()) {
    throw new Error(`${label} has a conflicting pending admin`);
  }
}

const actions = [];
if (!adapterAllowed) actions.push({ target: router, abi: pumpRouterAbi, functionName: "activateAdapter", args: [adapter] });
if (!routerEnabled) actions.push({ target: router, abi: pumpRouterAbi, functionName: "enableRouter", args: [] });
if (pumpAdmin.toLowerCase() !== controller.toLowerCase() && pumpPendingAdmin.toLowerCase() !== controller.toLowerCase()) {
  actions.push({ target: pump, abi: pumpAbi, functionName: "transferAdmin", args: [controller] });
}
if (routerAdmin.toLowerCase() !== controller.toLowerCase() && routerPendingAdmin.toLowerCase() !== controller.toLowerCase()) {
  actions.push({ target: router, abi: pumpRouterAbi, functionName: "transferAdmin", args: [controller] });
}
if (pumpAdmin.toLowerCase() !== controller.toLowerCase() && routerAdmin.toLowerCase() !== controller.toLowerCase()) {
  actions.push({ target: controller, abi: controllerAbi, functionName: "acceptProtocolAdmin", args: [] });
} else if (pumpAdmin.toLowerCase() !== controller.toLowerCase()) {
  actions.push({ target: controller, abi: controllerAbi, functionName: "acceptPumpAdmin", args: [] });
} else if (routerAdmin.toLowerCase() !== controller.toLowerCase()) {
  actions.push({ target: controller, abi: controllerAbi, functionName: "acceptRouterAdmin", args: [] });
}

if (!broadcast) {
  const directlySimulated = [];
  if (!adapterAllowed) {
    await publicClient.simulateContract({ address: router, abi: pumpRouterAbi, functionName: "activateAdapter", args: [adapter], account });
    directlySimulated.push("activateAdapter");
  }
  if (!routerEnabled) {
    await publicClient.simulateContract({ address: router, abi: pumpRouterAbi, functionName: "enableRouter", account });
    directlySimulated.push("enableRouter");
  }
  if (pumpAdmin.toLowerCase() !== controller.toLowerCase() && pumpPendingAdmin.toLowerCase() !== controller.toLowerCase()) {
    await publicClient.simulateContract({ address: pump, abi: pumpAbi, functionName: "transferAdmin", args: [controller], account });
    directlySimulated.push("transferPumpAdmin");
  }
  if (routerAdmin.toLowerCase() !== controller.toLowerCase() && routerPendingAdmin.toLowerCase() !== controller.toLowerCase()) {
    await publicClient.simulateContract({ address: router, abi: pumpRouterAbi, functionName: "transferAdmin", args: [controller], account });
    directlySimulated.push("transferRouterAdmin");
  }
  console.log(JSON.stringify({ mode: "simulation", governanceMode: mode, governance, readyAt: new Date(Number(block.timestamp) * 1000).toISOString(), controller, simulated: directlySimulated, dependentActions: actions.map((action) => action.functionName).filter((name) => name.startsWith("accept")), transactionCount: actions.length }, null, 2));
  process.exit(0);
}

const hashes = [];
for (const action of actions) {
  const { hash } = await sendContract(runtime, action.target, action.abi, action.functionName, action.args);
  hashes.push(hash);
}

[pumpAdmin, routerAdmin, routerEnabled, adapterAllowed] = await Promise.all([
  publicClient.readContract({ address: pump, abi: pumpAbi, functionName: "admin" }),
  publicClient.readContract({ address: router, abi: pumpRouterAbi, functionName: "admin" }),
  publicClient.readContract({ address: router, abi: pumpRouterAbi, functionName: "enabled" }),
  publicClient.readContract({ address: router, abi: pumpRouterAbi, functionName: "isAdapterAllowed", args: [adapter] }),
]);
if (
  pumpAdmin.toLowerCase() !== controller.toLowerCase()
  || routerAdmin.toLowerCase() !== controller.toLowerCase()
  || !routerEnabled
  || !adapterAllowed
) throw new Error("Graduation automation post-activation verification failed");

deployment.graduationAutomationStatus = "active-permissionless";
deployment.graduationAutomationActivatedAt = new Date().toISOString();
deployment.graduationAutomationActivationHashes = [
  ...(deployment.graduationAutomationActivationHashes || []),
  ...hashes,
];
network.deployment.graduationAutomationStatus = deployment.graduationAutomationStatus;
saveRuntime(network, deployment);
console.log(JSON.stringify({ mode: "broadcast", controller, active: true, transactionCount: hashes.length, transactionHashes: hashes }, null, 2));
