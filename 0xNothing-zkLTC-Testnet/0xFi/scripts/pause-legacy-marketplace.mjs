import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Pauses the retired native-zkLTC 0xPixel marketplace so its stale listings can no
// longer be bought at old prices. Dry run by default; `--broadcast` sends the one
// owner transaction. The key is read from .env.local in memory only, never printed.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, "deployments/liteforge-testnet/legacy-marketplace-pause.json");
const market = getAddress("0x13337cadA78d53C90E3c0EcE44C17c467C1a86F4");
const abi = parseAbi(["function owner() view returns (address)", "function paused() view returns (bool)", "function pause()"]);

async function run() {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.some((argument) => argument !== "--broadcast")) throw new Error("Invalid arguments");
  const broadcast = argumentsList.includes("--broadcast");
  const environment = dotenv.parse(fs.readFileSync(path.join(root, ".env.local"), "utf8"));
  const suppliedKey = String(environment.PRIVATE_KEY || environment.DEPLOYER_PRIVATE_KEY || "").trim();
  const key = suppliedKey.startsWith("0x") ? suppliedKey : `0x${suppliedKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Missing owner key");
  const account = privateKeyToAccount(key);
  const rpc = "https://liteforge.rpc.caldera.xyz/infra-partner-http";
  const chain = defineChain({ id: 4441, name: "LiteForge", nativeCurrency: { name: "zkLTC", symbol: "zkLTC", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const publicClient = createPublicClient({ chain, transport: http(rpc, { retryCount: 0, timeout: 30_000 }) });
  if (await publicClient.getChainId() !== 4441) throw new Error("RPC is not LiteForge 4441");
  const [owner, paused] = await Promise.all([
    publicClient.readContract({ address: market, abi, functionName: "owner" }),
    publicClient.readContract({ address: market, abi, functionName: "paused" }),
  ]);
  console.log(JSON.stringify({ market, owner, signer: account.address, paused }));
  if (paused) return console.log("Already paused; nothing to send.");
  if (owner.toLowerCase() !== account.address.toLowerCase()) throw new Error("The configured key is not the legacy marketplace owner");
  const { request } = await publicClient.simulateContract({ account, address: market, abi, functionName: "pause" });
  console.log("Simulation succeeded.");
  if (!broadcast) return console.log("Dry run only. Re-run with --broadcast to send the pause transaction.");
  const wallet = createWalletClient({ account, chain, transport: http(rpc, { retryCount: 0, timeout: 30_000 }) });
  const hash = await wallet.writeContract(request);
  console.log(JSON.stringify({ hash }));
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  const nowPaused = await publicClient.readContract({ address: market, abi, functionName: "paused", blockNumber: receipt.blockNumber });
  const record = { chainId: 4441, market, owner, transactionHash: hash, blockNumber: receipt.blockNumber.toString(), status: receipt.status, paused: nowPaused };
  fs.writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record));
  if (receipt.status !== "success" || !nowPaused) throw new Error("Pause transaction did not take effect");
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : "Pause failed");
  process.exitCode = 1;
});
