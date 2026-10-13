#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { createPublicClient, createWalletClient, fallback, getAddress, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { resolvePrivateKey } from "./lib/private-key.mjs";
import { fallbackRpcUrl, primaryRpcUrl, RPC_BATCH_OPTIONS } from "./lib/rpc.mjs";
import {
  decideSyncPrice,
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_LEAD_SECONDS,
  parseBoundedInteger,
  parseCliMode,
  resolveAdapterAddress,
  syncPriceAbi,
} from "./lib/sync-price-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });

const { once, dryRun } = parseCliMode(process.argv);
const network = JSON.parse(fs.readFileSync(path.join(root, "config", "liteforge-testnet.json"), "utf8"));
const adapter = getAddress(resolveAdapterAddress(
  process.env.SYNC_PRICE_ADAPTER,
  "0x6d18728bCB57c3Ce7DFb5A522fF22836280D6C98",
));
const leadSeconds = parseBoundedInteger(process.env.SYNC_PRICE_LEAD_SECONDS, {
  name: "SYNC_PRICE_LEAD_SECONDS",
  defaultValue: DEFAULT_LEAD_SECONDS,
  min: 0,
  max: 3_600,
});

const transport = fallback([
  http(primaryRpcUrl(network), RPC_BATCH_OPTIONS),
  http(fallbackRpcUrl(network), RPC_BATCH_OPTIONS),
]);
const publicClient = createPublicClient({ transport });
const abi = parseAbi(syncPriceAbi);

let walletClient;
let account;
if (!dryRun) {
  const resolved = resolvePrivateKey({ role: "keeper" });
  account = privateKeyToAccount(resolved.privateKey);
  walletClient = createWalletClient({ account, transport });
}

async function scan() {
  const chainId = await publicClient.getChainId();
  if (chainId !== 4441) throw new Error(`Wrong chain: expected 4441, received ${chainId}`);

  const [fresh, anchorPriceWad, anchorUpdatedAt, maxPriceAge] = await Promise.all([
    publicClient.readContract({ address: adapter, abi, functionName: "isFresh" }),
    publicClient.readContract({ address: adapter, abi, functionName: "anchorPriceWad" }),
    publicClient.readContract({ address: adapter, abi, functionName: "anchorUpdatedAt" }),
    publicClient.readContract({ address: adapter, abi, functionName: "maxPriceAge" }),
  ]);
  const now = Number((await publicClient.getBlock()).timestamp);
  const decision = decideSyncPrice({
    canReadPrice: fresh,
    anchorPriceWad,
    anchorUpdatedAt,
    maxPriceAge,
    now,
    leadSeconds,
  });
  const state = {
    chainId,
    adapter,
    fresh,
    anchorPriceWad: anchorPriceWad.toString(),
    anchorUpdatedAt: Number(anchorUpdatedAt),
    maxPriceAge: Number(maxPriceAge),
    now,
    ...decision,
  };
  console.log(JSON.stringify({ type: "scan", ...state }, null, 2));

  if (dryRun || decision.action !== "sync") return { ...state, synced: false };

  const simulation = await publicClient.simulateContract({
    account,
    address: adapter,
    abi,
    functionName: "syncPrice",
  });
  const hash = await walletClient.writeContract(simulation.request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`syncPrice reverted: ${hash}`);
  console.log(JSON.stringify({
    type: "synced",
    adapter,
    transactionHash: hash,
    block: receipt.blockNumber.toString(),
  }, null, 2));
  return { ...state, synced: true, transactionHash: hash };
}

if (once || dryRun) {
  const state = await scan();
  if (state.action === "sync" && dryRun) process.exitCode = 0;
} else {
  const intervalSeconds = parseBoundedInteger(process.env.SYNC_PRICE_INTERVAL_SECONDS, {
    name: "SYNC_PRICE_INTERVAL_SECONDS",
    defaultValue: DEFAULT_INTERVAL_SECONDS,
    min: 15,
    max: 3_600,
  });
  let consecutiveFailures = 0;
  while (true) {
    try {
      await scan();
      consecutiveFailures = 0;
    } catch (error) {
      console.error(error);
      consecutiveFailures += 1;
    }
    const backoffMultiplier = Math.min(2 ** consecutiveFailures, 8);
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * backoffMultiplier * 1000));
  }
}
