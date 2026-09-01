import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import {
  encodeDeployData,
  formatEther,
  getAddress,
  isAddress,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  atomicWriteFile,
  governanceAddress,
  loadRuntime,
  requiredAddress,
  root,
  saveRuntime,
} from "./lib/graduation-runtime.mjs";
import {
  mergeEnvironment,
  publicEnvironmentTargets,
  writePublicEnvironment,
} from "./lib/public-environment.mjs";

// The feature-specific 0xFi file remains the primary source. The workspace
// root file supplied by local operators is accepted only as a missing-value
// fallback, and is never copied wholesale into the web server environment.
dotenv.config({ path: path.resolve(root, "..", ".env.local"), quiet: true });
// A successfully generated signer is persisted in the gitignored web server
// environment before broadcast. Loading it last makes interrupted deployments
// recoverable without overriding the feature-specific or workspace files.
dotenv.config({ path: path.resolve(root, "..", "apps", "web", ".env.local"), quiet: true });

// Foundry deployment scripts historically use PRIVATE_KEY. Keep this
// compatibility fallback local to this deployer while preserving the explicit
// DEPLOYER_PRIVATE_KEY and legacy API_KEY precedence used by shared tooling.
if (
  !String(process.env.DEPLOYER_PRIVATE_KEY || "").trim()
  && !String(process.env.API_KEY || "").trim()
  && String(process.env.PRIVATE_KEY || "").trim()
) {
  process.env.DEPLOYER_PRIVATE_KEY = process.env.PRIVATE_KEY;
}

const broadcast = process.argv.includes("--broadcast");
if (process.argv.some((argument) => argument.startsWith("--") && argument !== "--broadcast")) {
  throw new Error("Usage: npm run points:deploy:check or npm run points:deploy:testnet");
}

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const pointsKey = String(process.env.POINTS_SIGNER_PRIVATE_KEY || "").trim();
if (!PRIVATE_KEY.test(pointsKey)) {
  throw new Error("POINTS_SIGNER_PRIVATE_KEY must be a dedicated 32-byte 0x-prefixed key");
}

const runtime = loadRuntime({ wallet: true });
const { network, deployment, publicClient, walletClient, account } = runtime;
const chainId = await publicClient.getChainId();
if (chainId !== Number(network.chainId)) {
  throw new Error(`Wrong chain: expected ${network.chainId}, received ${chainId}`);
}

const nusd = requiredAddress(deployment.nusd, "NUSD");
const owner = requiredAddress(process.env.NUSD_POINTS_OWNER || governanceAddress(deployment), "NUSD points owner");
const guardian = requiredAddress(process.env.NUSD_POINTS_GUARDIAN || deployment.guardian, "NUSD points guardian");
const pointsSigner = privateKeyToAccount(pointsKey).address;
if (
  pointsSigner.toLowerCase() === account.address.toLowerCase()
  || pointsSigner.toLowerCase() === owner.toLowerCase()
  || pointsSigner.toLowerCase() === guardian.toLowerCase()
) {
  throw new Error("The points signer must be separate from deployer, owner and guardian wallets");
}

const pointsAbi = [
  { type: "function", name: "nusd", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "guardian", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "redemptionSigner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "redemptionEnabled", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "nusdPerXPointWad", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isSolvent", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
];

async function verifySignerSafety({ requireFresh }) {
  const [code, balance, transactionCount] = await Promise.all([
    publicClient.getCode({ address: pointsSigner }),
    publicClient.getBalance({ address: pointsSigner }),
    publicClient.getTransactionCount({ address: pointsSigner }),
  ]);
  if (code && code !== "0x") throw new Error("POINTS_SIGNER_PRIVATE_KEY must resolve to an EOA");
  if (requireFresh && (balance !== 0n || transactionCount !== 0)) {
    throw new Error("Points signer must be a fresh, unfunded EOA with no transaction history");
  }
}

async function verifyDeployment(contract) {
  const code = await publicClient.getCode({ address: contract });
  if (!code || code === "0x") throw new Error("NUSD points staking address has no bytecode");
  const [boundNusd, boundOwner, boundGuardian, boundSigner, enabled, configuredRate, solvent] = await Promise.all([
    publicClient.readContract({ address: contract, abi: pointsAbi, functionName: "nusd" }),
    publicClient.readContract({ address: contract, abi: pointsAbi, functionName: "owner" }),
    publicClient.readContract({ address: contract, abi: pointsAbi, functionName: "guardian" }),
    publicClient.readContract({ address: contract, abi: pointsAbi, functionName: "redemptionSigner" }),
    publicClient.readContract({ address: contract, abi: pointsAbi, functionName: "redemptionEnabled" }),
    publicClient.readContract({ address: contract, abi: pointsAbi, functionName: "nusdPerXPointWad" }),
    publicClient.readContract({ address: contract, abi: pointsAbi, functionName: "isSolvent" }),
  ]);
  const bindings = [
    [boundNusd, nusd, "NUSD"],
    [boundOwner, owner, "owner"],
    [boundGuardian, guardian, "guardian"],
    [boundSigner, pointsSigner, "redemption signer"],
  ];
  const mismatch = bindings.find(([actual, expected]) => actual.toLowerCase() !== expected.toLowerCase());
  if (mismatch) throw new Error(`NUSD points ${mismatch[2]} binding is wrong`);
  if (!solvent) throw new Error("NUSD points staking contract is insolvent");
  return { enabled, configuredRate };
}

function writeServerEnvironment(values) {
  const target = publicEnvironmentTargets(root)[0];
  const source = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const domain = String(process.env.POINTS_SIGNING_DOMAIN || "127.0.0.1:3300").trim();
  if (!domain || /[\r\n]/.test(domain)) throw new Error("POINTS_SIGNING_DOMAIN is invalid");
  const contents = mergeEnvironment(source, {
    POINTS_SIGNER_PRIVATE_KEY: pointsKey,
    POINTS_SIGNING_DOMAIN: domain,
    ...values,
  });
  atomicWriteFile(target, contents);
}

function persistSignerEnvironment() {
  writeServerEnvironment({});
}

function syncServerEnvironment(contract) {
  writeServerEnvironment({ POINTS_STAKING_ADDRESS: contract });
}

function publishDeployment(contract) {
  deployment.nusdPointsStaking = contract;
  network.deployment.contracts.nusdPointsStaking = contract;
  saveRuntime(network, deployment);
  writePublicEnvironment({
    root,
    deployment,
    network,
    rpcUrl: process.env.LITEFORGE_RPC_URL,
    goldskyEndpoint: process.env.NEXT_PUBLIC_GOLDSKY_ENDPOINT,
  });
  syncServerEnvironment(contract);
}

function recordDeployment(contract, hash, blockNumber) {
  deployment.nusdPointsStaking = contract;
  deployment.nusdPointsStakingDeploymentBlock = blockNumber.toString();
  deployment.nusdPointsStakingDeploymentHash = hash;
  deployment.nusdPointsStakingStatus = "deployed-redemption-disabled";
  deployment.transactionHashes = [...new Set([...(deployment.transactionHashes || []), hash])];
  delete deployment.nusdPointsStakingPendingHash;
  delete deployment.nusdPointsStakingSubmittedAt;
  network.deployment.nusdPointsStakingDeploymentBlock = blockNumber.toString();
  network.deployment.nusdPointsStakingDeploymentHash = hash;
  network.deployment.nusdPointsStakingStatus = deployment.nusdPointsStakingStatus;
  publishDeployment(contract);
}

const recordedContract = deployment.nusdPointsStaking;
const hasRecordedContract = recordedContract !== undefined
  && recordedContract !== null
  && recordedContract !== "";
if (hasRecordedContract && (
  typeof recordedContract !== "string"
  || !isAddress(recordedContract)
)) {
  throw new Error("Recorded NUSD points staking address is invalid");
}
const existing = hasRecordedContract && recordedContract.toLowerCase() !== zeroAddress
  ? getAddress(recordedContract)
  : undefined;
const recordedPendingHash = deployment.nusdPointsStakingPendingHash;
const pendingHash = recordedPendingHash === undefined
  || recordedPendingHash === null
  || recordedPendingHash === ""
  ? undefined
  : recordedPendingHash;
if (pendingHash !== undefined && (
  typeof pendingHash !== "string"
  || !/^0x[0-9a-fA-F]{64}$/u.test(pendingHash)
)) {
  throw new Error("Recorded NUSD points deployment transaction hash is invalid");
}

// Freshness is a deployment-time policy. Once the signer is bound onchain, an
// attacker must not be able to block recovery or verification by dusting it.
await verifySignerSafety({ requireFresh: !existing && !pendingHash });

if (existing) {
  const state = await verifyDeployment(existing);
  // A broadcast rerun doubles as an idempotent finalizer if the transaction
  // landed but publishing either local environment file was interrupted.
  if (broadcast) publishDeployment(existing);
  console.log(JSON.stringify({
    mode: "existing",
    contract: existing,
    owner,
    guardian,
    signer: pointsSigner,
    redemptionEnabled: state.enabled,
    nusdPerXPointWad: state.configuredRate.toString(),
    bindingsVerified: true,
    publicationUpdated: broadcast,
  }, null, 2));
  process.exit(0);
}

if (pendingHash) {
  const receipt = await publicClient.getTransactionReceipt({ hash: pendingHash }).catch(() => null);
  if (!receipt) {
    console.log(JSON.stringify({ mode: "pending", transactionHash: pendingHash }, null, 2));
    process.exit(0);
  }
  if (receipt.status !== "success" || !receipt.contractAddress) {
    delete deployment.nusdPointsStakingPendingHash;
    delete deployment.nusdPointsStakingSubmittedAt;
    saveRuntime(network, deployment);
    throw new Error(`Pending NUSD points deployment reverted: ${pendingHash}`);
  }
  const recovered = getAddress(receipt.contractAddress);
  await verifyDeployment(recovered);
  recordDeployment(recovered, pendingHash, receipt.blockNumber);
  console.log(JSON.stringify({ mode: "recovered", contract: recovered, transactionHash: pendingHash }, null, 2));
  process.exit(0);
}

const artifactPath = path.join(root, "contracts", "out", "NusdPointsStaking.sol", "NusdPointsStaking.json");
if (!fs.existsSync(artifactPath)) throw new Error("Points artifact is missing; run npm run check:contracts first");
const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
const bytecode = artifact.bytecode?.object;
if (!/^0x[0-9a-fA-F]+$/.test(bytecode || "")) throw new Error("Points artifact bytecode is invalid");
const deploymentData = encodeDeployData({
  abi: artifact.abi,
  bytecode,
  args: [nusd, owner, guardian, pointsSigner],
});
await publicClient.call({ account, data: deploymentData });
const [estimatedGas, gasPrice, deployerBalance] = await Promise.all([
  publicClient.estimateGas({ account, data: deploymentData }),
  publicClient.getGasPrice(),
  publicClient.getBalance({ address: account.address }),
]);
const estimatedCost = estimatedGas * gasPrice;
if (deployerBalance < estimatedCost + estimatedCost / 5n) {
  throw new Error("Deployer balance is below deployment cost plus 20% buffer");
}
if (!broadcast) {
  console.log(JSON.stringify({
    mode: "simulation",
    chainId,
    deployer: account.address,
    owner,
    guardian,
    signer: pointsSigner,
    nusd,
    estimatedGas: estimatedGas.toString(),
    estimatedCostZkLtc: formatEther(estimatedCost),
    deployerBalanceZkLtc: formatEther(deployerBalance),
    redemptionEnabledAtDeployment: false,
    deployable: true,
  }, null, 2));
  process.exit(0);
}

// Persist only after every fresh-deployment preflight, but before submitting,
// so a mined transaction is recoverable if receipt polling times out. Existing
// and recovered contracts publish their signer only after binding verification.
persistSignerEnvironment();
const hash = await walletClient.deployContract({
  abi: artifact.abi,
  bytecode,
  args: [nusd, owner, guardian, pointsSigner],
  account,
});
deployment.nusdPointsStakingPendingHash = hash;
deployment.nusdPointsStakingSubmittedAt = new Date().toISOString();
saveRuntime(network, deployment);
const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
if (receipt.status !== "success" || !receipt.contractAddress) {
  delete deployment.nusdPointsStakingPendingHash;
  delete deployment.nusdPointsStakingSubmittedAt;
  saveRuntime(network, deployment);
  throw new Error(`NUSD points deployment reverted: ${hash}`);
}
const contract = getAddress(receipt.contractAddress);
await verifyDeployment(contract);
recordDeployment(contract, hash, receipt.blockNumber);

console.log(JSON.stringify({
  mode: "broadcast",
  contract,
  transactionHash: hash,
  blockNumber: receipt.blockNumber.toString(),
  redemptionEnabled: false,
  webEnvironmentUpdated: true,
}, null, 2));
