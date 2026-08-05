import process from "node:process";

import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
} from "viem";

import {
  governanceAddress,
  governanceMode,
  loadRuntime,
  requiredAddress,
  saveRuntime,
  sendContract,
} from "./lib/graduation-runtime.mjs";

const broadcast = process.argv.includes("--broadcast");
if (process.argv.some((argument) => argument.startsWith("--") && argument !== "--broadcast")) {
  throw new Error("Usage: npm run activate:core:check or npm run activate:core");
}

const runtime = loadRuntime({ wallet: broadcast });
const { deployment, network, publicClient } = runtime;
const chainId = await publicClient.getChainId();
if (chainId !== Number(network.chainId) || chainId !== Number(deployment.chainId)) {
  throw new Error(`Wrong chain: expected ${network.chainId}, received ${chainId}`);
}
const mode = governanceMode(deployment);
const governance = governanceAddress(deployment);
const deployer = requiredAddress(deployment.deployer, "deployer");
const guardian = requiredAddress(deployment.guardian || deployment.deployer, "guardian");
const currentTargets = [
  deployment.dexFactory,
  deployment.gaugeFactory,
  deployment.nBTCVault,
  deployment.nETHVault,
  deployment.lendingPool,
].map((address, index) => requiredAddress(address, `core target ${index + 1}`));
const ownableAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function guardian() view returns (address)",
  "function acceptOwnership()",
]);

async function ownershipState(targets) {
  return Promise.all(targets.map(async (address) => {
    const [owner, pendingOwner, currentGuardian] = await Promise.all([
      publicClient.readContract({ address, abi: ownableAbi, functionName: "owner" }),
      publicClient.readContract({ address, abi: ownableAbi, functionName: "pendingOwner" }),
      publicClient.readContract({ address, abi: ownableAbi, functionName: "guardian" }),
    ]);
    return { address, owner, pendingOwner, guardian: currentGuardian };
  }));
}

let state = await ownershipState(currentTargets);
const wrongGuardians = state.filter((item) => item.guardian.toLowerCase() !== guardian.toLowerCase());
if (wrongGuardians.length) throw new Error("One or more core guardian bindings differ from the manifest");

const hashes = [];
if (mode === "transition") {
  throw new Error("Governance transition is incomplete; run/finalize the direct-governance migration before activation");
} else if (mode === "direct") {
  const conflicts = state.filter((item) => (
    item.owner.toLowerCase() !== governance.toLowerCase()
    || item.pendingOwner.toLowerCase() !== zeroAddress
  ));
  if (conflicts.length) {
    throw new Error(
      "Direct-governance manifest conflicts with live ownership; complete/finalize the direct-governance migration before activation",
    );
  }
} else {
  const timelock = governance;
  const timelockAbi = parseAbi([
    "function getTimestamp(bytes32 id) view returns (uint256)",
    "function hashOperationBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt) view returns (bytes32)",
    "function executeBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt) payable",
  ]);
  const groups = [];
  const legacy = deployment.legacyContracts;
  if (deployment.ownershipOperationId) {
    const targets = legacy
      ? [deployment.dexFactory, legacy.gaugeFactory, legacy.nBTCVault, legacy.nETHVault, legacy.lendingPool]
      : currentTargets;
    groups.push({ id: deployment.ownershipOperationId, label: "initial ownership", targets });
  }
  if (deployment.migrationOwnershipOperationId) {
    groups.push({
      id: deployment.migrationOwnershipOperationId,
      label: "migration ownership",
      targets: [deployment.gaugeFactory, deployment.nBTCVault, deployment.nETHVault, deployment.lendingPool],
    });
  }
  if (!groups.length && state.some((item) => item.owner.toLowerCase() !== governance.toLowerCase())) {
    throw new Error("Timelock ownership is incomplete but no operation ID is recorded");
  }

  const block = await publicClient.getBlock();
  for (const group of groups) {
    const targets = group.targets.map((address, index) => requiredAddress(address, `${group.label} target ${index + 1}`));
    const groupState = await ownershipState(targets);
    if (groupState.every((item) => item.owner.toLowerCase() === governance.toLowerCase())) continue;
    if (groupState.some((item) => (
      item.owner.toLowerCase() !== deployer.toLowerCase()
      || item.pendingOwner.toLowerCase() !== governance.toLowerCase()
    ))) throw new Error(`${group.label} has a conflicting owner or pending owner`);

    const values = targets.map(() => 0n);
    const payloads = targets.map(() => encodeFunctionData({ abi: ownableAbi, functionName: "acceptOwnership" }));
    const predecessor = `0x${"0".repeat(64)}`;
    const salt = keccak256(encodeAbiParameters(
      parseAbiParameters("string,uint256,address,address[]"),
      ["0xFi ownership handover", BigInt(chainId), deployer, targets],
    ));
    const recordedId = group.id.toLowerCase();
    const computedId = await publicClient.readContract({
      address: timelock,
      abi: timelockAbi,
      functionName: "hashOperationBatch",
      args: [targets, values, payloads, predecessor, salt],
    });
    if (computedId.toLowerCase() !== recordedId) throw new Error(`${group.label} operation ID does not match its batch`);
    const timestamp = await publicClient.readContract({
      address: timelock,
      abi: timelockAbi,
      functionName: "getTimestamp",
      args: [group.id],
    });
    if (timestamp === 0n) throw new Error(`${group.label} is not scheduled`);
    if (timestamp === 1n) throw new Error(`${group.label} is marked done but ownership is incomplete`);
    if (timestamp > block.timestamp) {
      const readyAt = new Date(Number(timestamp) * 1000).toISOString();
      if (broadcast) throw new Error(`${group.label} is not ready until ${readyAt}`);
      console.log(JSON.stringify({ mode: "check", governanceMode: mode, ready: false, operation: group.label, readyAt }, null, 2));
      process.exitCode = 1;
      process.exit();
    }
    if (!broadcast) {
      await publicClient.simulateContract({
        account: deployer,
        address: timelock,
        abi: timelockAbi,
        functionName: "executeBatch",
        args: [targets, values, payloads, predecessor, salt],
      });
    } else {
      const { hash } = await sendContract(runtime, timelock, timelockAbi, "executeBatch", [
        targets,
        values,
        payloads,
        predecessor,
        salt,
      ]);
      hashes.push(hash);
    }
  }

  if (broadcast) state = await ownershipState(currentTargets);
  const incomplete = state.filter((item) => item.owner.toLowerCase() !== governance.toLowerCase());
  if (broadcast && incomplete.length) throw new Error("Core ownership post-activation verification failed");
}

if (broadcast) {
  deployment.coreOwnershipActivatedAt = new Date().toISOString();
  deployment.coreOwnershipActivationHashes = [
    ...(deployment.coreOwnershipActivationHashes || []),
    ...hashes,
  ];
  network.deployment.coreOwnershipActivatedAt = deployment.coreOwnershipActivatedAt;
  network.deployment.ownershipActivated = true;
  saveRuntime(network, deployment);
}

console.log(JSON.stringify({
  mode: broadcast ? "broadcast" : "check",
  governanceMode: mode,
  governance,
  guardian,
  ready: true,
  transactionsSent: hashes.length,
  transactionHashes: hashes,
}, null, 2));
