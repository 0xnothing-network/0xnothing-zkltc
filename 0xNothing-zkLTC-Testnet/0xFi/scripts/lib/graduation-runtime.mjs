import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  fallback,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { resolvePrivateKey } from "./private-key.mjs";
import { fallbackRpcUrl, primaryRpcUrl, RPC_BATCH_OPTIONS } from "./rpc.mjs";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });

export const networkPath = path.join(root, "config", "liteforge-testnet.json");
export const deploymentPath = path.join(root, "contracts", "deployments", "latest.json");

export function atomicWriteFile(target, contents) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function governanceMode(deployment) {
  const explicit = String(deployment.governanceMode || "").toLowerCase();
  if (explicit === "direct-deployer-no-timelock" || explicit === "direct") return "direct";
  if (explicit === "timelock" || explicit === "timelocked") return "timelock";
  if (explicit.startsWith("transition")) return "transition";
  if (
    String(deployment.status || "").toLowerCase().includes("direct-governance")
    || deployment.riskMode === "direct-deployer-no-timelock"
  ) return "direct";
  return "timelock";
}

export function governanceAddress(deployment) {
  const mode = governanceMode(deployment);
  const value = deployment.governance || (mode === "direct" || mode === "transition" ? deployment.deployer : deployment.timelock);
  return requiredAddress(value, `${mode} governance`);
}

export function loadRuntime({ wallet = false, walletRole = "deployer" } = {}) {
  if (!fs.existsSync(deploymentPath)) throw new Error("0xFi deployment manifest is missing");
  const network = JSON.parse(fs.readFileSync(networkPath, "utf8"));
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  if (Number(deployment.chainId) !== Number(network.chainId)) throw new Error("Deployment chain mismatch");

  // Fail closed on a missing endpoint instead of letting `.trim()` throw a bare
  // TypeError, so an unconfigured network config names the variable to set.
  const transport = fallback([
    http(primaryRpcUrl(network), RPC_BATCH_OPTIONS),
    http(fallbackRpcUrl(network), RPC_BATCH_OPTIONS),
  ]);
  const publicClient = createPublicClient({ transport });
  if (!wallet) return { network, deployment, publicClient };

  const { privateKey } = resolvePrivateKey({ role: walletRole });
  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({ account, transport });
  return { network, deployment, publicClient, walletClient, account };
}

export function saveRuntime(network, deployment) {
  atomicWriteFile(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`);
  atomicWriteFile(networkPath, `${JSON.stringify(network, null, 2)}\n`);
}

export async function sendContract({ publicClient, walletClient, account }, address, abi, functionName, args = []) {
  const simulation = await publicClient.simulateContract({ address, abi, functionName, args, account });
  const hash = await walletClient.writeContract(simulation.request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  return { hash, receipt };
}

export const pumpAbi = parseAbi([
  "function admin() view returns (address)",
  "function pendingAdmin() view returns (address)",
  "function getAllTokens() view returns (address[])",
  "function status(address token) view returns (uint8)",
  "function transferAdmin(address newAdmin)",
]);

export const pumpRouterAbi = parseAbi([
  "function admin() view returns (address)",
  "function pendingAdmin() view returns (address)",
  "function enabled() view returns (bool)",
  "function isAdapterAllowed(address adapter) view returns (bool)",
  "function enableAt() view returns (uint256)",
  "function adapterActivationTime(address adapter) view returns (uint256)",
  "function activateAdapter(address adapter)",
  "function enableRouter()",
  "function transferAdmin(address newAdmin)",
]);

export const controllerAbi = parseAbi([
  "constructor(address pump,address adapter,address governance,address guardian)",
  "function pump() view returns (address)",
  "function adapter() view returns (address)",
  "function router() view returns (address)",
  "function governance() view returns (address)",
  "function guardian() view returns (address)",
  "function graduationsPaused() view returns (bool)",
  "function acceptPumpAdmin()",
  "function acceptRouterAdmin()",
  "function acceptProtocolAdmin()",
  "function graduateReady(address token) returns (address dex,bytes32 pairId,address pool,address lpToken,uint256 lpAmount)",
  "function previewGraduation(address token) view returns ((bool ready,address pool,uint256 tokenAmount,uint256 nusdAmount,uint256 expectedLp,uint256 minimumLp))",
]);

export function requiredAddress(value, label) {
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${label} is not a valid address`);
  }
}
