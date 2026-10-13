#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { createPublicClient, createWalletClient, fallback, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { resolvePrivateKey } from "./lib/private-key.mjs";
import { fallbackRpcUrl, primaryRpcUrl, RPC_BATCH_OPTIONS } from "./lib/rpc.mjs";
import {
  parseSeedAmounts,
  pairIsLiquid,
  planLiquiditySeed,
  resolveSeedTargets,
  seedPlanNeedsBroadcast,
} from "./lib/seed-liquidity-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });

const broadcast = process.argv.includes("--broadcast");
if (process.argv.some((argument) => argument.startsWith("--") && argument !== "--broadcast")) {
  throw new Error("Use no flag for a dry-run plan or --broadcast to seed the three LiteForge pairs");
}

const networkPath = path.join(root, "config", "liteforge-testnet.json");
const network = JSON.parse(fs.readFileSync(networkPath, "utf8"));
const targets = resolveSeedTargets(network);
const amounts = parseSeedAmounts(process.env);
const WAD = 10n ** 18n;

const transport = fallback([
  http(primaryRpcUrl(network), RPC_BATCH_OPTIONS),
  http(fallbackRpcUrl(network), RPC_BATCH_OPTIONS),
]);
const publicClient = createPublicClient({ transport });
const chainId = await publicClient.getChainId();
if (chainId !== 4441 || chainId !== Number(network.chainId)) {
  throw new Error(`Wrong chain: expected 4441, received ${chainId}`);
}

let account;
let walletClient;
if (broadcast) {
  const resolved = resolvePrivateKey({ role: "deployer" });
  account = privateKeyToAccount(resolved.privateKey);
  walletClient = createWalletClient({ account, transport });
}

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const oracleAbi = parseAbi([
  "function isFresh() view returns (bool)",
  "function readPriceWad() view returns (uint256 priceWad,uint256 updatedAt,uint80 roundId)",
]);
const pairAbi = parseAbi([
  "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)",
]);
const vaultAbi = parseAbi([
  "function activated() view returns (bool)",
  "function mintPaused() view returns (bool)",
  "function quoteDepositAndMint(address,uint256) view returns (uint256 syntheticAmount,uint256 reserveRequiredNusd,bool oneToOneAvailable)",
  "function quoteMintFee(uint256) view returns (uint256 feeNusd)",
  "function depositAndMint(uint256 collateralAmountNusd,uint256 syntheticAmount,uint256 maximumFeeNusd,address recipient)",
]);
const routerAbi = parseAbi([
  "function addLiquidity((address tokenA,address tokenB,uint256 amountADesired,uint256 amountBDesired,uint256 amountAMin,uint256 amountBMin,uint256 minimumLiquidity,address to,uint256 deadline) params) returns (uint256 amountA,uint256 amountB,uint256 liquidity)",
  "function addLiquidityNative((address token,uint256 amountTokenDesired,uint256 amountTokenMin,uint256 amountNativeMin,uint256 minimumLiquidity,address to,uint256 deadline) params) payable returns (uint256 amountToken,uint256 amountNative,uint256 liquidity)",
]);

const sent = [];
const read = (address, abi, functionName, args = []) => publicClient.readContract({
  address,
  abi,
  functionName,
  args,
});

async function send(address, abi, functionName, args = [], options = {}) {
  if (!broadcast) throw new Error("A state-changing action was reached during dry-run");
  const simulation = await publicClient.simulateContract({
    account,
    address,
    abi,
    functionName,
    args,
    ...(options.value === undefined ? {} : { value: options.value }),
  });
  const hash = await walletClient.writeContract(simulation.request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  sent.push({ functionName, transactionHash: hash, block: receipt.blockNumber });
  return { hash, receipt };
}

async function approveExact(token, spender, owner, amount) {
  const allowance = await read(token, erc20Abi, "allowance", [owner, spender]);
  if (allowance === amount) return;
  if (allowance !== 0n) await send(token, erc20Abi, "approve", [spender, 0n]);
  await send(token, erc20Abi, "approve", [spender, amount]);
}

async function freshPrice(oracle, label) {
  const [fresh, snapshot] = await Promise.all([
    read(oracle, oracleAbi, "isFresh"),
    read(oracle, oracleAbi, "readPriceWad"),
  ]);
  if (!fresh || snapshot[0] === 0n) throw new Error(`${label} oracle is not fresh`);
  return snapshot[0];
}

const [coreReserves, nbtcReserves, nethReserves, nbtcActivated, nbtcPaused, nethActivated, nethPaused] = await Promise.all([
  read(targets.corePair, pairAbi, "getReserves"),
  read(targets.nbtcPair, pairAbi, "getReserves"),
  read(targets.nethPair, pairAbi, "getReserves"),
  read(targets.nbtcVault, vaultAbi, "activated"),
  read(targets.nbtcVault, vaultAbi, "mintPaused"),
  read(targets.nethVault, vaultAbi, "activated"),
  read(targets.nethVault, vaultAbi, "mintPaused"),
]);

const actions = planLiquiditySeed({
  coreLiquid: pairIsLiquid(coreReserves),
  amounts,
  markets: [
    { symbol: "nBTC", liquid: pairIsLiquid(nbtcReserves), vaultActivated: nbtcActivated, mintPaused: nbtcPaused },
    { symbol: "nETH", liquid: pairIsLiquid(nethReserves), vaultActivated: nethActivated, mintPaused: nethPaused },
  ],
});

const report = {
  mode: broadcast ? "broadcast" : "dry-run",
  chainId,
  source: "config/liteforge-testnet.json",
  nusd: targets.nusd,
  amounts: {
    coreNusd: amounts.coreNusd.toString(),
    synthCollateralNusd: amounts.synthCollateralNusd.toString(),
  },
  actions: actions.map((action) => ({ ...action, nusd: action.nusd.toString() })),
};

if (!broadcast) {
  await Promise.all([
    freshPrice(targets.ltcOracle, "LTC"),
    freshPrice(targets.btcOracle, "BTC"),
    freshPrice(targets.ethOracle, "ETH"),
  ]);
  console.log(JSON.stringify({ ...report, needsBroadcast: seedPlanNeedsBroadcast(actions) }, null, 2));
  process.exit();
}

const owner = account.address;

async function seedCore() {
  const ltcPrice = await freshPrice(targets.ltcOracle, "LTC");
  const nativeAmount = amounts.coreNusd * WAD / ltcPrice;
  if (nativeAmount === 0n) throw new Error("Native bootstrap amount rounded to zero");
  const nusdBalance = await read(targets.nusd, erc20Abi, "balanceOf", [owner]);
  if (nusdBalance < amounts.coreNusd) throw new Error("Not enough NUSD for the wzkLTC/NUSD seed");
  await approveExact(targets.nusd, targets.router, owner, amounts.coreNusd);
  const block = await publicClient.getBlock();
  await send(targets.router, routerAbi, "addLiquidityNative", [{
    token: targets.nusd,
    amountTokenDesired: amounts.coreNusd,
    amountTokenMin: amounts.coreNusd,
    amountNativeMin: nativeAmount,
    minimumLiquidity: 1n,
    to: owner,
    deadline: block.timestamp + 3600n,
  }], { value: nativeAmount });
}

async function seedSynth(symbol) {
  const market = symbol === "nBTC"
    ? { asset: targets.nbtc, vault: targets.nbtcVault, oracle: targets.btcOracle }
    : { asset: targets.neth, vault: targets.nethVault, oracle: targets.ethOracle };
  const quote = await read(market.vault, vaultAbi, "quoteDepositAndMint", [owner, amounts.synthCollateralNusd]);
  if (quote[0] === 0n) throw new Error(`${symbol} mint quote rounded to zero`);
  const mintFee = await read(market.vault, vaultAbi, "quoteMintFee", [quote[0]]);
  const debit = amounts.synthCollateralNusd + mintFee;
  const nusdBefore = await read(targets.nusd, erc20Abi, "balanceOf", [owner]);
  if (nusdBefore < debit) throw new Error(`Not enough NUSD to mint ${symbol}`);
  await approveExact(targets.nusd, market.vault, owner, debit);
  await send(market.vault, vaultAbi, "depositAndMint", [
    amounts.synthCollateralNusd,
    quote[0],
    mintFee,
    owner,
  ]);
  const assetBalance = await read(market.asset, erc20Abi, "balanceOf", [owner]);
  if (assetBalance === 0n) throw new Error(`${symbol} mint left a zero wallet balance`);
  const price = await freshPrice(market.oracle, symbol);
  const quoteNusd = assetBalance * price / WAD;
  if (quoteNusd === 0n) throw new Error(`${symbol} NUSD quote rounded to zero`);
  const nusdBalance = await read(targets.nusd, erc20Abi, "balanceOf", [owner]);
  if (nusdBalance < quoteNusd) throw new Error(`Not enough NUSD to seed ${symbol}`);
  await approveExact(market.asset, targets.router, owner, assetBalance);
  await approveExact(targets.nusd, targets.router, owner, quoteNusd);
  const block = await publicClient.getBlock();
  await send(targets.router, routerAbi, "addLiquidity", [{
    tokenA: market.asset,
    tokenB: targets.nusd,
    amountADesired: assetBalance,
    amountBDesired: quoteNusd,
    amountAMin: assetBalance,
    amountBMin: quoteNusd,
    minimumLiquidity: 1n,
    to: owner,
    deadline: block.timestamp + 3600n,
  }]);
}

for (const action of actions) {
  if (action.action === "seed-native") await seedCore();
  if (action.action === "seed-synth") await seedSynth(action.id.split("/")[0]);
}

console.log(JSON.stringify({ ...report, transactions: sent }, (key, value) => (
  typeof value === "bigint" ? value.toString() : value
), 2));
