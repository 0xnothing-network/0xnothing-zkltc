#!/usr/bin/env node

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
  CURRENT_LENDING_COLLATERAL_RISK,
  CURRENT_LENDING_IMPLEMENTATION_ID,
} from "./lib/lending-implementation.mjs";
import { writePublicEnvironment } from "./lib/public-environment.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });

const CHAIN_ID = 4441;
const ENTRY_TVL_NUSD = 100_000n * 10n ** 18n;
const EXIT_TVL_NUSD = 90_000n * 10n ** 18n;
const ACTIVATION_DELAY = 24n * 60n * 60n;
const predictionPath = path.join(root, "contracts", "deployments", "synth-safety-reserve.json");
const latestPath = path.join(root, "contracts", "deployments", "latest.json");
const networkPath = path.join(root, "config", "liteforge-testnet.json");
const subgraphConfigPath = path.join(root, "subgraph", "subgraph.config.json");
const subgraphPackagePath = path.join(root, "subgraph", "package.json");
const subgraphTemplatePath = path.join(root, "subgraph", "subgraph.template.yaml");
const subgraphManifestPath = path.join(root, "subgraph", "subgraph.yaml");
const broadcastPath = path.join(
  root,
  "contracts",
  "broadcast",
  "MigrateSynthSafetyReserve.s.sol",
  String(CHAIN_ID),
  "run-latest.json",
);

const artifactPaths = {
  GaugeFactory: path.join(root, "contracts", "out", "GaugeFactory.sol", "GaugeFactory.json"),
  SynthSafetyReserve: path.join(root, "contracts", "out", "SynthSafetyReserve.sol", "SynthSafetyReserve.json"),
  SyntheticAsset: path.join(root, "contracts", "out", "SyntheticAsset.sol", "SyntheticAsset.json"),
  SyntheticVault: path.join(root, "contracts", "out", "SyntheticVault.sol", "SyntheticVault.json"),
  ZeroXFiRouter: path.join(root, "contracts", "out", "ZeroXFiRouter.sol", "ZeroXFiRouter.json"),
};

for (const [label, file] of [
  ["migration prediction", predictionPath],
  ["active deployment", latestPath],
  ["network config", networkPath],
  ["broadcast journal", broadcastPath],
  ["subgraph config", subgraphConfigPath],
  ["subgraph package", subgraphPackagePath],
  ["subgraph template", subgraphTemplatePath],
  ...Object.entries(artifactPaths).map(([name, file]) => [`${name} artifact`, file]),
]) {
  if (!fs.existsSync(file)) throw new Error(`${label} is missing: ${file}`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function address(value, label) {
  if (!isAddress(value)) throw new Error(`${label} is not a valid address`);
  return getAddress(value);
}

function uint(value, label) {
  try {
    const result = BigInt(String(value));
    if (result < 0n) throw new Error();
    return result;
  } catch {
    throw new Error(`${label} is not an unsigned integer`);
  }
}

function sameAddress(left, right) {
  return address(left, "address").toLowerCase() === address(right, "address").toLowerCase();
}

function requireAddress(actual, expected, label) {
  if (!sameAddress(actual, expected)) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

const prediction = readJson(predictionPath);
const previous = readJson(latestPath);
const network = readJson(networkPath);
const subgraphConfig = readJson(subgraphConfigPath);
const subgraphPackage = readJson(subgraphPackagePath);
const broadcast = readJson(broadcastPath);
const subgraphDeploymentName = String(network.goldsky?.subgraph || "").split("/")[0];
const subgraphVersion = String(subgraphPackage.version || "");
if (!/^[a-zA-Z0-9_-]+$/.test(subgraphDeploymentName) || !/^\d+\.\d+\.\d+$/.test(subgraphVersion)) {
  throw new Error("Goldsky deployment name or subgraph package version is invalid");
}

if (Number(prediction.chainId) !== CHAIN_ID) throw new Error("Prediction chain ID is invalid");
if (![
  "synth-safety-reserve-migration-prediction",
  "synth-safety-reserve-migration-staged",
].includes(prediction.status)) {
  throw new Error(`Prediction status is not recoverable: ${prediction.status}`);
}
if (prediction.status === "synth-safety-reserve-migration-staged") {
  requireEqual(prediction.broadcasted, true, "staged prediction broadcast marker");
}
requireEqual(prediction.vaultActivationRequired, true, "prediction activation requirement");
const rpcUrl = (process.env.LITEFORGE_RPC_URL || network.rpcUrl || "").trim();
const fallbackUrl = (process.env.LITEFORGE_FALLBACK_RPC_URL || "https://liteforge.rpc.caldera.xyz/http").trim();
if (!rpcUrl) throw new Error("LITEFORGE_RPC_URL or network.rpcUrl is required");
const client = createPublicClient({ transport: fallback([http(rpcUrl), http(fallbackUrl)]) });
const chainId = await client.getChainId();
if (chainId !== CHAIN_ID) throw new Error(`Wrong chain: expected ${CHAIN_ID}, got ${chainId}`);

const addresses = {
  deployer: address(prediction.deployer, "deployer"),
  nusd: address(previous.nusd, "NUSD"),
  factory: address(previous.dexFactory, "DEX factory"),
  gaugeFactory: address(previous.gaugeFactory, "legacy gauge factory"),
  synthFeeGaugeFactory: address(prediction.synthFeeGaugeFactory, "synth fee gauge factory"),
  dexRouter: address(prediction.dexRouter, "new DEX router"),
  wzkLTC: address(previous.wzkLTC, "WzkLTC"),
  lending: address(previous.lendingPool, "lending pool"),
  btcOracle: address(previous.btcOracle, "BTC oracle"),
  ethOracle: address(previous.ethOracle, "ETH oracle"),
  reserve: address(prediction.synthSafetyReserve, "synth safety reserve"),
  nBTC: address(prediction.nBTC, "new nBTC"),
  nETH: address(prediction.nETH, "new nETH"),
  nBTCVault: address(prediction.nBTCVault, "new nBTC vault"),
  nETHVault: address(prediction.nETHVault, "new nETH vault"),
  nBTCNusdPair: address(prediction.nBTCNusdPair, "new nBTC/NUSD pair"),
  nETHNusdPair: address(prediction.nETHNusdPair, "new nETH/NUSD pair"),
  nBTCNusdGauge: address(prediction.nBTCNusdGauge, "new nBTC/NUSD gauge"),
  nETHNusdGauge: address(prediction.nETHNusdGauge, "new nETH/NUSD gauge"),
  oldNBTC: address(prediction.oldNBTC, "old nBTC"),
  oldNETH: address(prediction.oldNETH, "old nETH"),
  oldNBTCVault: address(prediction.oldNBTCVault, "old nBTC vault"),
  oldNETHVault: address(prediction.oldNETHVault, "old nETH vault"),
  oldNBTCNusdPair: address(prediction.oldNBTCNusdPair, "old nBTC/NUSD pair"),
  oldNETHNusdPair: address(prediction.oldNETHNusdPair, "old nETH/NUSD pair"),
  oldNBTCNusdGauge: address(prediction.oldNBTCNusdGauge, "old nBTC/NUSD gauge"),
  oldNETHNusdGauge: address(prediction.oldNETHNusdGauge, "old nETH/NUSD gauge"),
};

function requireRecoverableReplacement(
  actual,
  oldAddress,
  newAddress,
  migration,
  oldKey,
  newKey,
  label,
) {
  if (sameAddress(actual, oldAddress)) return;
  if (!sameAddress(actual, newAddress)) {
    throw new Error(`${label}: expected ${oldAddress} or ${newAddress}, got ${actual}`);
  }
  requireAddress(migration?.[oldKey], oldAddress, `${label} staged previous address`);
  requireAddress(migration?.[newKey], newAddress, `${label} staged replacement address`);
}

for (const [property, predictionOldKey, migrationOldKey] of [
  ["nBTC", "oldNBTC", "previousNBTC"],
  ["nETH", "oldNETH", "previousNETH"],
  ["nBTCVault", "oldNBTCVault", "previousNBTCVault"],
  ["nETHVault", "oldNETHVault", "previousNETHVault"],
  ["nBTCNusdPair", "oldNBTCNusdPair", "previousNBTCNusdPair"],
  ["nETHNusdPair", "oldNETHNusdPair", "previousNETHNusdPair"],
  ["nBTCNusdGauge", "oldNBTCNusdGauge", "previousNBTCNusdGauge"],
  ["nETHNusdGauge", "oldNETHNusdGauge", "previousNETHNusdGauge"],
]) {
  for (const [actual, migration, label] of [
    [previous[property], previous.synthSafetyReserveMigration, `top-level ${property}`],
    [previous.contracts?.[property], previous.synthSafetyReserveMigration, `nested ${property}`],
    [
      network.deployment?.contracts?.[property],
      network.deployment?.synthSafetyReserveMigration,
      `network ${property}`,
    ],
  ]) {
    requireRecoverableReplacement(
      actual,
      prediction[predictionOldKey],
      prediction[property],
      migration,
      migrationOldKey,
      property,
      label,
    );
  }
}
for (const [contracts, migration, label] of [
  [previous, previous.synthSafetyReserveMigration, "top-level synth topology"],
  [previous.contracts, previous.synthSafetyReserveMigration, "nested synth topology"],
  [
    network.deployment?.contracts,
    network.deployment?.synthSafetyReserveMigration,
    "network synth topology",
  ],
]) {
  if (!migration) {
    if (contracts?.synthFeeGaugeFactory || contracts?.synthSafetyReserve) {
      throw new Error(`${label} contains unrecorded staged contracts`);
    }
    continue;
  }
  requireAddress(contracts?.dexRouter, addresses.dexRouter, `${label} DEX router`);
  requireAddress(
    contracts?.synthFeeGaugeFactory,
    addresses.synthFeeGaugeFactory,
    `${label} fee gauge factory`,
  );
  requireAddress(contracts?.synthSafetyReserve, addresses.reserve, `${label} safety reserve`);
}
if (previous.synthRiskActionsEnabled === true) {
  throw new Error("The staged synth markets are already activated; refusing to restage them");
}
requireAddress(addresses.deployer, previous.deployer, "migration deployer");
requireAddress(prediction.gaugeFactory, addresses.gaugeFactory, "legacy gauge factory continuity");
requireAddress(prediction.lendingPool, addresses.lending, "fixed-rate lending pool continuity");
requireAddress(network.deployment?.contracts?.lendingPool, addresses.lending, "network lending pool continuity");
requireEqual(uint(prediction.sponsorshipEntryTvlNusd, "entry TVL"), ENTRY_TVL_NUSD, "entry TVL");
requireEqual(uint(prediction.sponsorshipExitTvlNusd, "exit TVL"), EXIT_TVL_NUSD, "exit TVL");
requireEqual(uint(prediction.sponsorshipActivationDelay, "activation delay"), ACTIVATION_DELAY, "activation delay");

const transactions = broadcast.transactions || [];
const expectedCreates = {
  GaugeFactory: [addresses.synthFeeGaugeFactory],
  SynthSafetyReserve: [addresses.reserve],
  SyntheticAsset: [addresses.nBTC, addresses.nETH],
  SyntheticVault: [addresses.nBTCVault, addresses.nETHVault],
  ZeroXFiRouter: [addresses.dexRouter],
};
for (const [contractName, expectedAddresses] of Object.entries(expectedCreates)) {
  const creates = transactions.filter((transaction) => (
    transaction.transactionType === "CREATE" && transaction.contractName === contractName
  ));
  requireEqual(creates.length, expectedAddresses.length, `${contractName} CREATE count`);
  const artifact = readJson(artifactPaths[contractName]);
  const remainingAddresses = new Set(expectedAddresses.map((value) => value.toLowerCase()));
  for (const create of creates) {
    requireAddress(create.transaction?.from, addresses.deployer, `${contractName} CREATE sender`);
    const createdAddress = address(create.contractAddress, `${contractName} CREATE address`);
    if (!remainingAddresses.delete(createdAddress.toLowerCase())) {
      throw new Error(`${contractName} was created at an unexpected address: ${createdAddress}`);
    }
    if (!creationInputMatchesArtifact(create.transaction?.input, artifact.bytecode?.object)) {
      throw new Error(`${contractName} creation input does not match the current artifact`);
    }
  }
  requireEqual(remainingAddresses.size, 0, `${contractName} expected CREATE addresses`);
}

for (const transaction of transactions) {
  requireAddress(transaction.transaction?.from, addresses.deployer, "migration transaction sender");
  if (!/^0x[0-9a-fA-F]{64}$/.test(transaction.hash || "")) {
    throw new Error("Broadcast journal contains a transaction without a valid hash");
  }
}
const hashes = [...new Set(transactions.map((transaction) => transaction.hash))];
if (hashes.length === 0) throw new Error("Broadcast journal contains no transaction hashes");
requireEqual(hashes.length, transactions.length, "unique migration transaction hashes");
const receipts = [];
for (const hash of hashes) {
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`Migration transaction reverted: ${hash}`);
  receipts.push(receipt);
}
const receiptByHash = new Map(receipts.map((receipt) => [
  receipt.transactionHash.toLowerCase(),
  receipt,
]));
for (const transaction of transactions) {
  const receipt = receiptByHash.get(transaction.hash.toLowerCase());
  if (!receipt) throw new Error(`Missing receipt evidence for ${transaction.hash}`);
  requireAddress(receipt.from, addresses.deployer, `receipt sender for ${transaction.hash}`);
  if (transaction.transactionType === "CREATE") {
    if (!receipt.contractAddress) {
      throw new Error(`CREATE receipt has no contract address: ${transaction.hash}`);
    }
    requireAddress(
      receipt.contractAddress,
      transaction.contractAddress,
      `CREATE receipt address for ${transaction.hash}`,
    );
  } else if (transaction.transaction?.to) {
    if (!receipt.to) throw new Error(`Call receipt has no target: ${transaction.hash}`);
    requireAddress(receipt.to, transaction.transaction.to, `receipt target for ${transaction.hash}`);
  }
}
const deploymentBlock = receipts.reduce(
  (minimum, receipt) => receipt.blockNumber < minimum ? receipt.blockNumber : minimum,
  receipts[0].blockNumber,
);

const newContractAddresses = [
  addresses.synthFeeGaugeFactory,
  addresses.dexRouter,
  addresses.reserve,
  addresses.nBTC,
  addresses.nETH,
  addresses.nBTCVault,
  addresses.nETHVault,
  addresses.nBTCNusdPair,
  addresses.nETHNusdPair,
  addresses.nBTCNusdGauge,
  addresses.nETHNusdGauge,
];
await Promise.all(newContractAddresses.map(async (contractAddress) => {
  const code = await client.getCode({ address: contractAddress });
  if (!code || code === "0x") throw new Error(`No bytecode at ${contractAddress}`);
}));

const ownableAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function guardian() view returns (address)",
]);
const erc20Abi = parseAbi([
  "function owner() view returns (address)",
  "function vault() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);
const reserveAbi = parseAbi([
  "function nusd() view returns (address)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function guardian() view returns (address)",
  "function ENTRY_TVL_NUSD() view returns (uint256)",
  "function EXIT_TVL_NUSD() view returns (uint256)",
  "function ACTIVATION_DELAY() view returns (uint256)",
  "function authorizedVault(address) view returns (bool)",
  "function vaultsBound() view returns (bool)",
  "function vault0() view returns (address)",
  "function vault1() view returns (address)",
  "function totalReserveNusd() view returns (uint256)",
  "function freeReserveNusd() view returns (uint256)",
  "function totalAllocatedNusd() view returns (uint256)",
  "function sponsorshipActive() view returns (bool)",
  "function eligibleSince() view returns (uint256)",
  "function allocationsPaused() view returns (bool)",
]);
const vaultAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function guardian() view returns (address)",
  "function nusd() view returns (address)",
  "function syntheticAsset() view returns (address)",
  "function oracle() view returns (address)",
  "function safetyReserve() view returns (address)",
  "function mintFeeDistributor() view returns (address)",
  "function debtCeilingSynthetic() view returns (uint256)",
  "function totalCollateralNusd() view returns (uint256)",
  "function totalDebtSynthetic() view returns (uint256)",
  "function totalBadDebtSynthetic() view returns (uint256)",
  "function mintPaused() view returns (bool)",
  "function withdrawPaused() view returns (bool)",
  "function activated() view returns (bool)",
]);
const factoryAbi = parseAbi([
  "function getPair(address,address) view returns (address)",
  "function isPair(address) view returns (bool)",
]);
const gaugeFactoryAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function guardian() view returns (address)",
  "function nusd() view returns (address)",
  "function dexFactory() view returns (address)",
  "function gaugeForPair(address) view returns (address)",
  "function mintFeePairForVault(address) view returns (address)",
  "function mintFeeVaultForPair(address) view returns (address)",
  "function allGaugesLength() view returns (uint256)",
  "function totalPendingMintFeesNusd() view returns (uint256)",
  "function MINT_FEE_REWARD_DURATION() view returns (uint256)",
]);
const routerAbi = parseAbi([
  "function factory() view returns (address)",
  "function wzkLTC() view returns (address)",
  "function FEE_DENOMINATOR() view returns (uint256)",
  "function LP_FEE_BPS() view returns (uint256)",
  "function PROTOCOL_FEE_BPS() view returns (uint256)",
  "function ROUTE_SURCHARGE_BPS() view returns (uint256)",
]);
const pairAbi = parseAbi([
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function getReserves() view returns (uint112,uint112,uint32)",
]);
const gaugeAbi = parseAbi([
  "function stakingToken() view returns (address)",
  "function rewardToken() view returns (address)",
  "function distributor() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function totalFunded() view returns (uint256)",
  "function totalPaid() view returns (uint256)",
  "function rewardRate() view returns (uint256)",
  "function periodFinish() view returns (uint256)",
  "function lastUpdateTime() view returns (uint256)",
  "function rewardPerTokenStored() view returns (uint256)",
  "function depositsPaused() view returns (bool)",
  "function pausedRewardDuration() view returns (uint256)",
]);
const lendingAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function guardian() view returns (address)",
  "function nusd() view returns (address)",
  "function IMPLEMENTATION_ID() view returns (bytes32)",
  "function activated() view returns (bool)",
  "function bootstrapOpen() view returns (bool)",
  "function supplyPaused() view returns (bool)",
  "function borrowPaused() view returns (bool)",
  "function collateralWithdrawalPaused() view returns (bool)",
  "function totalBorrowed() view returns (uint256)",
  "function totalBadDebtNusd() view returns (uint256)",
  "function collateralAssetCount() view returns (uint256)",
  "function collateralAssetAt(uint256) view returns (address)",
  "function collateralConfigs(address) view returns (address,uint256,uint16,uint16,uint16,uint8,bool,uint16)",
  "function totalCollateralByAsset(address) view returns (uint256)",
]);
const oracleAbi = parseAbi(["function readPriceWad() view returns (uint256,uint256,uint256)"]);

async function read(contractAddress, abi, functionName, args = []) {
  return client.readContract({ address: contractAddress, abi, functionName, args });
}

const synthFeeFactoryState = await Promise.all([
  read(addresses.synthFeeGaugeFactory, gaugeFactoryAbi, "owner"),
  read(addresses.synthFeeGaugeFactory, gaugeFactoryAbi, "pendingOwner"),
  read(addresses.synthFeeGaugeFactory, gaugeFactoryAbi, "guardian"),
  read(addresses.synthFeeGaugeFactory, gaugeFactoryAbi, "nusd"),
  read(addresses.synthFeeGaugeFactory, gaugeFactoryAbi, "dexFactory"),
  read(addresses.synthFeeGaugeFactory, gaugeFactoryAbi, "allGaugesLength"),
  read(addresses.synthFeeGaugeFactory, gaugeFactoryAbi, "totalPendingMintFeesNusd"),
  read(addresses.synthFeeGaugeFactory, gaugeFactoryAbi, "MINT_FEE_REWARD_DURATION"),
  read(addresses.synthFeeGaugeFactory, gaugeFactoryAbi, "mintFeePairForVault", [addresses.nBTCVault]),
  read(addresses.synthFeeGaugeFactory, gaugeFactoryAbi, "mintFeePairForVault", [addresses.nETHVault]),
  read(addresses.synthFeeGaugeFactory, gaugeFactoryAbi, "mintFeeVaultForPair", [addresses.nBTCNusdPair]),
  read(addresses.synthFeeGaugeFactory, gaugeFactoryAbi, "mintFeeVaultForPair", [addresses.nETHNusdPair]),
  read(addresses.nusd, erc20Abi, "balanceOf", [addresses.synthFeeGaugeFactory]),
]);
requireAddress(synthFeeFactoryState[0], addresses.deployer, "synth fee factory owner");
requireAddress(synthFeeFactoryState[1], zeroAddress, "synth fee factory pending owner");
requireAddress(synthFeeFactoryState[2], addresses.deployer, "synth fee factory guardian");
requireAddress(synthFeeFactoryState[3], addresses.nusd, "synth fee factory NUSD");
requireAddress(synthFeeFactoryState[4], addresses.factory, "synth fee factory DEX factory");
requireEqual(synthFeeFactoryState[5], 2n, "synth fee factory gauge count");
requireEqual(synthFeeFactoryState[6], 0n, "synth fee factory pending fees");
requireEqual(synthFeeFactoryState[7], 7n * 24n * 60n * 60n, "synth fee reward duration");
requireAddress(synthFeeFactoryState[8], addresses.nBTCNusdPair, "nBTC vault fee pair route");
requireAddress(synthFeeFactoryState[9], addresses.nETHNusdPair, "nETH vault fee pair route");
requireAddress(synthFeeFactoryState[10], addresses.nBTCVault, "nBTC pair fee vault route");
requireAddress(synthFeeFactoryState[11], addresses.nETHVault, "nETH pair fee vault route");
requireEqual(synthFeeFactoryState[12], 0n, "synth fee factory raw NUSD");

const routerState = await Promise.all([
  read(addresses.dexRouter, routerAbi, "factory"),
  read(addresses.dexRouter, routerAbi, "wzkLTC"),
  read(addresses.dexRouter, routerAbi, "FEE_DENOMINATOR"),
  read(addresses.dexRouter, routerAbi, "LP_FEE_BPS"),
  read(addresses.dexRouter, routerAbi, "PROTOCOL_FEE_BPS"),
  read(addresses.dexRouter, routerAbi, "ROUTE_SURCHARGE_BPS"),
]);
requireAddress(routerState[0], addresses.factory, "new router factory");
requireAddress(routerState[1], addresses.wzkLTC, "new router WzkLTC");
requireEqual(routerState[2], 10_000n, "new router fee denominator");
requireEqual(routerState[3], 50n, "new router LP fee");
requireEqual(routerState[4], 10n, "new router protocol fee");
requireEqual(routerState[5], 10n, "new router route surcharge");

const reserveState = await Promise.all([
  read(addresses.reserve, reserveAbi, "nusd"),
  read(addresses.reserve, reserveAbi, "owner"),
  read(addresses.reserve, reserveAbi, "pendingOwner"),
  read(addresses.reserve, reserveAbi, "guardian"),
  read(addresses.reserve, reserveAbi, "ENTRY_TVL_NUSD"),
  read(addresses.reserve, reserveAbi, "EXIT_TVL_NUSD"),
  read(addresses.reserve, reserveAbi, "ACTIVATION_DELAY"),
  read(addresses.reserve, reserveAbi, "authorizedVault", [addresses.nBTCVault]),
  read(addresses.reserve, reserveAbi, "authorizedVault", [addresses.nETHVault]),
  read(addresses.reserve, reserveAbi, "vaultsBound"),
  read(addresses.reserve, reserveAbi, "vault0"),
  read(addresses.reserve, reserveAbi, "vault1"),
  read(addresses.reserve, reserveAbi, "totalReserveNusd"),
  read(addresses.reserve, reserveAbi, "freeReserveNusd"),
  read(addresses.reserve, reserveAbi, "totalAllocatedNusd"),
  read(addresses.reserve, reserveAbi, "sponsorshipActive"),
  read(addresses.reserve, reserveAbi, "eligibleSince"),
  read(addresses.reserve, reserveAbi, "allocationsPaused"),
  read(addresses.nusd, erc20Abi, "balanceOf", [addresses.reserve]),
]);
requireAddress(reserveState[0], addresses.nusd, "reserve NUSD");
requireAddress(reserveState[1], addresses.deployer, "reserve owner");
requireAddress(reserveState[2], zeroAddress, "reserve pending owner");
requireAddress(reserveState[3], addresses.deployer, "reserve guardian");
requireEqual(reserveState[4], ENTRY_TVL_NUSD, "reserve entry TVL");
requireEqual(reserveState[5], EXIT_TVL_NUSD, "reserve exit TVL");
requireEqual(reserveState[6], ACTIVATION_DELAY, "reserve activation delay");
requireEqual(reserveState[7], true, "nBTC vault reserve authorization");
requireEqual(reserveState[8], true, "nETH vault reserve authorization");
requireEqual(reserveState[9], true, "reserve vault binding finality");
requireAddress(reserveState[10], addresses.nBTCVault, "reserve vault0");
requireAddress(reserveState[11], addresses.nETHVault, "reserve vault1");
requireEqual(reserveState[12], reserveState[13], "reserve total/free accounting");
requireEqual(reserveState[13], reserveState[18], "reserve free/raw NUSD accounting");
requireEqual(reserveState[14], 0n, "reserve allocated");
requireEqual(reserveState[16], 0n, "reserve eligibleSince");
requireEqual(reserveState[15], false, "reserve sponsorship state");
requireEqual(reserveState[17], false, "reserve allocation pause");

async function verifyAsset(asset, vault, label) {
  const [owner, boundVault, supply] = await Promise.all([
    read(asset, erc20Abi, "owner"),
    read(asset, erc20Abi, "vault"),
    read(asset, erc20Abi, "totalSupply"),
  ]);
  requireAddress(owner, zeroAddress, `${label} owner`);
  requireAddress(boundVault, vault, `${label} vault binding`);
  requireEqual(supply, 0n, `${label} supply`);
}

async function verifyVault(vault, asset, oracle, ceiling, label, retired = false) {
  const state = await Promise.all([
    read(vault, vaultAbi, "owner"),
    read(vault, vaultAbi, "pendingOwner"),
    read(vault, vaultAbi, "guardian"),
    read(vault, vaultAbi, "nusd"),
    read(vault, vaultAbi, "syntheticAsset"),
    read(vault, vaultAbi, "oracle"),
    ...(!retired ? [read(vault, vaultAbi, "safetyReserve")] : []),
    ...(!retired ? [read(vault, vaultAbi, "mintFeeDistributor")] : []),
    read(vault, vaultAbi, "debtCeilingSynthetic"),
    read(vault, vaultAbi, "totalCollateralNusd"),
    read(vault, vaultAbi, "totalDebtSynthetic"),
    read(vault, vaultAbi, "totalBadDebtSynthetic"),
    read(vault, vaultAbi, "mintPaused"),
    read(vault, vaultAbi, "withdrawPaused"),
    ...(!retired ? [read(vault, vaultAbi, "activated")] : []),
    read(addresses.nusd, erc20Abi, "balanceOf", [vault]),
    ...(!retired ? [read(addresses.nusd, erc20Abi, "allowance", [vault, addresses.reserve])] : []),
    ...(!retired
      ? [read(addresses.nusd, erc20Abi, "allowance", [vault, addresses.synthFeeGaugeFactory])]
      : []),
    read(asset, erc20Abi, "balanceOf", [vault]),
  ]);
  let index = 0;
  requireAddress(state[index++], addresses.deployer, `${label} owner`);
  requireAddress(state[index++], zeroAddress, `${label} pending owner`);
  requireAddress(state[index++], addresses.deployer, `${label} guardian`);
  requireAddress(state[index++], addresses.nusd, `${label} NUSD`);
  requireAddress(state[index++], asset, `${label} asset`);
  requireAddress(state[index++], oracle, `${label} oracle`);
  if (!retired) requireAddress(state[index++], addresses.reserve, `${label} reserve`);
  if (!retired) requireAddress(state[index++], addresses.synthFeeGaugeFactory, `${label} mint fee distributor`);
  requireEqual(state[index++], ceiling, `${label} debt ceiling`);
  const collateral = state[index++];
  if (!retired) requireEqual(collateral, 0n, `${label} collateral`);
  requireEqual(state[index++], 0n, `${label} debt`);
  requireEqual(state[index++], 0n, `${label} bad debt`);
  requireEqual(state[index++], true, `${label} mint pause`);
  requireEqual(state[index++], !retired, `${label} withdrawal pause`);
  if (!retired) requireEqual(state[index++], false, `${label} activation state`);
  const rawNusdBalance = state[index++];
  if (rawNusdBalance < collateral) {
    throw new Error(`${label} raw NUSD is below accounted collateral`);
  }
  if (!retired) requireEqual(state[index++], 2n ** 256n - 1n, `${label} reserve allowance`);
  if (!retired) requireEqual(state[index++], 0n, `${label} mint fee allowance`);
  requireEqual(state[index], 0n, `${label} asset balance`);
}

const nbtcCeiling = uint(prediction.nBTCDebtCeiling, "nBTC ceiling");
const nethCeiling = uint(prediction.nETHDebtCeiling, "nETH ceiling");
await Promise.all([
  verifyAsset(addresses.nBTC, addresses.nBTCVault, "new nBTC"),
  verifyAsset(addresses.nETH, addresses.nETHVault, "new nETH"),
  verifyVault(addresses.nBTCVault, addresses.nBTC, addresses.btcOracle, nbtcCeiling, "new nBTC vault"),
  verifyVault(addresses.nETHVault, addresses.nETH, addresses.ethOracle, nethCeiling, "new nETH vault"),
  verifyVault(addresses.oldNBTCVault, addresses.oldNBTC, addresses.btcOracle, nbtcCeiling, "old nBTC vault", true),
  verifyVault(addresses.oldNETHVault, addresses.oldNETH, addresses.ethOracle, nethCeiling, "old nETH vault", true),
]);

for (const [asset, label] of [[addresses.oldNBTC, "old nBTC"], [addresses.oldNETH, "old nETH"]]) {
  requireEqual(await read(asset, erc20Abi, "totalSupply"), 0n, `${label} supply`);
}

async function verifyPair(pair, asset, label) {
  const [factory, token0, token1, supply, reserves, registered] = await Promise.all([
    read(pair, pairAbi, "factory"),
    read(pair, pairAbi, "token0"),
    read(pair, pairAbi, "token1"),
    read(pair, pairAbi, "totalSupply"),
    read(pair, pairAbi, "getReserves"),
    read(addresses.factory, factoryAbi, "isPair", [pair]),
  ]);
  requireAddress(factory, addresses.factory, `${label} factory`);
  const tokenBinding = (sameAddress(token0, asset) && sameAddress(token1, addresses.nusd))
    || (sameAddress(token0, addresses.nusd) && sameAddress(token1, asset));
  if (!tokenBinding) throw new Error(`${label} token binding is invalid`);
  requireEqual(registered, true, `${label} registration`);
  requireEqual(supply, 0n, `${label} LP supply`);
  requireEqual(reserves[0], 0n, `${label} reserve0`);
  requireEqual(reserves[1], 0n, `${label} reserve1`);
}

async function verifyGauge(gauge, pair, distributor, label, retired) {
  const state = await Promise.all([
    read(gauge, gaugeAbi, "stakingToken"),
    read(gauge, gaugeAbi, "rewardToken"),
    read(gauge, gaugeAbi, "distributor"),
    read(gauge, gaugeAbi, "totalSupply"),
    read(gauge, gaugeAbi, "totalFunded"),
    read(gauge, gaugeAbi, "totalPaid"),
    read(gauge, gaugeAbi, "rewardRate"),
    read(gauge, gaugeAbi, "periodFinish"),
    read(gauge, gaugeAbi, "lastUpdateTime"),
    read(gauge, gaugeAbi, "rewardPerTokenStored"),
    read(gauge, gaugeAbi, "depositsPaused"),
    ...(!retired ? [read(gauge, gaugeAbi, "pausedRewardDuration")] : []),
  ]);
  requireAddress(state[0], pair, `${label} staking token`);
  requireAddress(state[1], addresses.nusd, `${label} reward token`);
  requireAddress(state[2], distributor, `${label} distributor`);
  for (const [index, suffix] of [[3, "stake"], [4, "funded"], [5, "paid"], [6, "rate"], [7, "period finish"], [8, "last update"], [9, "reward accumulator"]]) {
    requireEqual(state[index], 0n, `${label} ${suffix}`);
  }
  requireEqual(state[10], true, `${label} deposit pause`);
  if (!retired) requireEqual(state[11], 0n, `${label} paused reward duration`);
}

await Promise.all([
  verifyPair(addresses.nBTCNusdPair, addresses.nBTC, "new nBTC pair"),
  verifyPair(addresses.nETHNusdPair, addresses.nETH, "new nETH pair"),
  verifyPair(addresses.oldNBTCNusdPair, addresses.oldNBTC, "old nBTC pair"),
  verifyPair(addresses.oldNETHNusdPair, addresses.oldNETH, "old nETH pair"),
  verifyGauge(
    addresses.nBTCNusdGauge,
    addresses.nBTCNusdPair,
    addresses.synthFeeGaugeFactory,
    "new nBTC gauge",
    false,
  ),
  verifyGauge(
    addresses.nETHNusdGauge,
    addresses.nETHNusdPair,
    addresses.synthFeeGaugeFactory,
    "new nETH gauge",
    false,
  ),
  verifyGauge(
    addresses.oldNBTCNusdGauge,
    addresses.oldNBTCNusdPair,
    addresses.gaugeFactory,
    "old nBTC gauge",
    true,
  ),
  verifyGauge(
    addresses.oldNETHNusdGauge,
    addresses.oldNETHNusdPair,
    addresses.gaugeFactory,
    "old nETH gauge",
    true,
  ),
]);

requireAddress(
  await read(addresses.factory, factoryAbi, "getPair", [addresses.nBTC, addresses.nusd]),
  addresses.nBTCNusdPair,
  "new nBTC pair lookup",
);
requireAddress(
  await read(addresses.factory, factoryAbi, "getPair", [addresses.nETH, addresses.nusd]),
  addresses.nETHNusdPair,
  "new nETH pair lookup",
);
requireAddress(
  await read(addresses.synthFeeGaugeFactory, gaugeFactoryAbi, "gaugeForPair", [addresses.nBTCNusdPair]),
  addresses.nBTCNusdGauge,
  "new nBTC gauge lookup",
);
requireAddress(
  await read(addresses.synthFeeGaugeFactory, gaugeFactoryAbi, "gaugeForPair", [addresses.nETHNusdPair]),
  addresses.nETHNusdGauge,
  "new nETH gauge lookup",
);
requireAddress(
  await read(addresses.gaugeFactory, gaugeFactoryAbi, "gaugeForPair", [addresses.oldNBTCNusdPair]),
  addresses.oldNBTCNusdGauge,
  "old nBTC gauge lookup",
);
requireAddress(
  await read(addresses.gaugeFactory, gaugeFactoryAbi, "gaugeForPair", [addresses.oldNETHNusdPair]),
  addresses.oldNETHNusdGauge,
  "old nETH gauge lookup",
);

const lendingState = await Promise.all([
  read(addresses.lending, lendingAbi, "owner"),
  read(addresses.lending, lendingAbi, "pendingOwner"),
  read(addresses.lending, lendingAbi, "guardian"),
  read(addresses.lending, lendingAbi, "nusd"),
  read(addresses.lending, lendingAbi, "IMPLEMENTATION_ID"),
  read(addresses.lending, lendingAbi, "activated"),
  read(addresses.lending, lendingAbi, "bootstrapOpen"),
  read(addresses.lending, lendingAbi, "supplyPaused"),
  read(addresses.lending, lendingAbi, "borrowPaused"),
  read(addresses.lending, lendingAbi, "collateralWithdrawalPaused"),
  read(addresses.lending, lendingAbi, "totalBorrowed"),
  read(addresses.lending, lendingAbi, "totalBadDebtNusd"),
  read(addresses.lending, lendingAbi, "collateralAssetCount"),
  ...[0n, 1n, 2n, 3n, 4n].map((index) => (
    read(addresses.lending, lendingAbi, "collateralAssetAt", [index])
  )),
  read(addresses.lending, lendingAbi, "totalCollateralByAsset", [addresses.wzkLTC]),
]);
requireAddress(lendingState[0], addresses.deployer, "staged lending owner");
requireAddress(lendingState[1], zeroAddress, "staged lending pending owner");
requireAddress(lendingState[2], addresses.deployer, "staged lending guardian");
requireAddress(lendingState[3], addresses.nusd, "staged lending NUSD");
requireEqual(
  String(lendingState[4]).toLowerCase(),
  CURRENT_LENDING_IMPLEMENTATION_ID,
  "staged lending implementation",
);
requireEqual(lendingState[5], false, "staged lending activation");
requireEqual(lendingState[6], false, "staged lending bootstrap state");
requireEqual(lendingState[7], true, "staged lending supply pause");
requireEqual(lendingState[8], true, "staged lending borrow pause");
requireEqual(lendingState[9], true, "staged lending collateral-withdrawal pause");
requireEqual(lendingState[10], 0n, "staged lending debt");
requireEqual(lendingState[11], 0n, "staged lending bad debt");
requireEqual(lendingState[12], 5n, "staged lending collateral count");
for (const [index, expected] of [
  [13, addresses.wzkLTC],
  [14, addresses.oldNBTC],
  [15, addresses.oldNETH],
  [16, addresses.nBTC],
  [17, addresses.nETH],
]) requireAddress(lendingState[index], expected, `staged lending collateral asset ${index - 13}`);
requireEqual(lendingState[18], 0n, "staged WzkLTC lending collateral");

async function verifyCollateral(asset, oracle, cap, enabled, label) {
  const [config, total, rawBalance] = await Promise.all([
    read(addresses.lending, lendingAbi, "collateralConfigs", [asset]),
    read(addresses.lending, lendingAbi, "totalCollateralByAsset", [asset]),
    read(asset, erc20Abi, "balanceOf", [addresses.lending]),
  ]);
  requireAddress(config[0], oracle, `${label} lending oracle`);
  requireEqual(config[1], cap, `${label} lending cap`);
  requireEqual(config[2], CURRENT_LENDING_COLLATERAL_RISK.loanToValueBps, `${label} lending LTV`);
  requireEqual(
    config[3],
    CURRENT_LENDING_COLLATERAL_RISK.liquidationThresholdBps,
    `${label} liquidation threshold`,
  );
  requireEqual(
    config[4],
    CURRENT_LENDING_COLLATERAL_RISK.liquidationBonusBps,
    `${label} liquidation bonus`,
  );
  requireEqual(config[5], CURRENT_LENDING_COLLATERAL_RISK.decimals, `${label} decimals`);
  requireEqual(config[6], enabled, `${label} enabled`);
  requireEqual(
    config[7],
    CURRENT_LENDING_COLLATERAL_RISK.marginCallThresholdBps,
    `${label} margin-call threshold`,
  );
  requireEqual(total, 0n, `${label} lending collateral`);
  requireEqual(rawBalance, 0n, `${label} raw lending balance`);
}

const nbtcCap = uint(prediction.nBTCLendingCollateralCap, "nBTC lending cap");
const nethCap = uint(prediction.nETHLendingCollateralCap, "nETH lending cap");
await Promise.all([
  verifyCollateral(addresses.oldNBTC, addresses.btcOracle, nbtcCap, false, "old nBTC"),
  verifyCollateral(addresses.oldNETH, addresses.ethOracle, nethCap, false, "old nETH"),
  verifyCollateral(addresses.nBTC, addresses.btcOracle, nbtcCap, true, "new nBTC"),
  verifyCollateral(addresses.nETH, addresses.ethOracle, nethCap, true, "new nETH"),
]);

for (const [oracle, label] of [[addresses.btcOracle, "BTC"], [addresses.ethOracle, "ETH"]]) {
  const snapshot = await read(oracle, oracleAbi, "readPriceWad");
  if (snapshot[0] <= 0n || snapshot[1] <= 0n || snapshot[2] <= 0n) {
    throw new Error(`${label} oracle returned an invalid snapshot`);
  }
}

function migrationMatches(migration) {
  try {
    return Boolean(
      migration
        && sameAddress(migration.reserve, addresses.reserve)
        && sameAddress(migration.synthFeeGaugeFactory, addresses.synthFeeGaugeFactory)
        && sameAddress(migration.nBTC, addresses.nBTC)
        && sameAddress(migration.nETH, addresses.nETH)
        && sameAddress(migration.nBTCVault, addresses.nBTCVault)
        && sameAddress(migration.nETHVault, addresses.nETHVault)
        && sameAddress(migration.nBTCNusdPair, addresses.nBTCNusdPair)
        && sameAddress(migration.nETHNusdPair, addresses.nETHNusdPair)
        && sameAddress(migration.nBTCNusdGauge, addresses.nBTCNusdGauge)
        && sameAddress(migration.nETHNusdGauge, addresses.nETHNusdGauge),
    );
  } catch {
    return false;
  }
}
const existingMigration = [
  previous.synthSafetyReserveMigration,
  network.deployment?.synthSafetyReserveMigration,
].find(migrationMatches);
const finalizedAt = existingMigration?.finalizedAt || prediction.finalizedAt || new Date().toISOString();
const migrationRecord = {
  reserve: addresses.reserve,
  synthFeeGaugeFactory: addresses.synthFeeGaugeFactory,
  previousDexRouter: existingMigration?.previousDexRouter || previous.dexRouter,
  dexRouter: addresses.dexRouter,
  previousNBTC: addresses.oldNBTC,
  previousNETH: addresses.oldNETH,
  previousNBTCVault: addresses.oldNBTCVault,
  previousNETHVault: addresses.oldNETHVault,
  previousNBTCNusdPair: addresses.oldNBTCNusdPair,
  previousNETHNusdPair: addresses.oldNETHNusdPair,
  previousNBTCNusdGauge: addresses.oldNBTCNusdGauge,
  previousNETHNusdGauge: addresses.oldNETHNusdGauge,
  nBTC: addresses.nBTC,
  nETH: addresses.nETH,
  nBTCVault: addresses.nBTCVault,
  nETHVault: addresses.nETHVault,
  nBTCNusdPair: addresses.nBTCNusdPair,
  nETHNusdPair: addresses.nETHNusdPair,
  nBTCNusdGauge: addresses.nBTCNusdGauge,
  nETHNusdGauge: addresses.nETHNusdGauge,
  block: String(deploymentBlock),
  finalizedAt,
  transactionHashes: hashes,
  entryTvlNusd: ENTRY_TVL_NUSD.toString(),
  exitTvlNusd: EXIT_TVL_NUSD.toString(),
  activationDelaySeconds: ACTIVATION_DELAY.toString(),
  legacyWithdrawalsOpen: true,
  userNusdMoved: "0",
  activationRequired: true,
  activationCompleted: false,
};
const transactionHashes = [...new Set([...(previous.transactionHashes || []), ...hashes])];
const replacementContracts = {
  dexRouter: addresses.dexRouter,
  synthFeeGaugeFactory: addresses.synthFeeGaugeFactory,
  synthSafetyReserve: addresses.reserve,
  nBTC: addresses.nBTC,
  nETH: addresses.nETH,
  nBTCVault: addresses.nBTCVault,
  nETHVault: addresses.nETHVault,
  nBTCNusdPair: addresses.nBTCNusdPair,
  nETHNusdPair: addresses.nETHNusdPair,
  nBTCNusdGauge: addresses.nBTCNusdGauge,
  nETHNusdGauge: addresses.nETHNusdGauge,
};
const nextDeployment = {
  ...previous,
  ...replacementContracts,
  synthSafetyReserveStatus: "threshold-hysteresis-24h-delay",
  synthSafetyReserveMigration: migrationRecord,
  synthRiskActivationStatus: "pending-owner-activation",
  synthRiskActionsEnabled: false,
  transactionHashes,
  contracts: { ...previous.contracts, ...replacementContracts },
};
const nextNetwork = {
  ...network,
  goldsky: {
    ...network.goldsky,
    subgraph: `${subgraphDeploymentName}/${subgraphVersion}`,
  },
  deployment: {
    ...network.deployment,
    synthSafetyReserveStatus: nextDeployment.synthSafetyReserveStatus,
    synthSafetyReserveMigration: migrationRecord,
    synthRiskActivationStatus: "pending-owner-activation",
    synthRiskActionsEnabled: false,
    contracts: { ...network.deployment?.contracts, ...replacementContracts },
  },
};
const startBlock = Number(deploymentBlock);
if (!Number.isSafeInteger(startBlock)) throw new Error("Migration block is outside JavaScript's safe integer range");
const nextSubgraphConfig = {
  ...subgraphConfig,
  synthFeeGaugeFactoryAddress: addresses.synthFeeGaugeFactory,
  synthFeeGaugeFactoryStartBlock: startBlock,
  nbtcVaultAddress: addresses.nBTCVault,
  nethVaultAddress: addresses.nETHVault,
  nbtcVaultStartBlock: startBlock,
  nethVaultStartBlock: startBlock,
};
const subgraphManifest = fs.readFileSync(subgraphTemplatePath, "utf8")
  .replaceAll("__NETWORK__", nextSubgraphConfig.network)
  .replaceAll("__FACTORY_ADDRESS__", nextSubgraphConfig.factoryAddress)
  .replaceAll("__GAUGE_FACTORY_ADDRESS__", nextSubgraphConfig.gaugeFactoryAddress)
  .replaceAll("__SYNTH_FEE_GAUGE_FACTORY_ADDRESS__", nextSubgraphConfig.synthFeeGaugeFactoryAddress)
  .replaceAll("__NBTC_VAULT_ADDRESS__", nextSubgraphConfig.nbtcVaultAddress)
  .replaceAll("__NETH_VAULT_ADDRESS__", nextSubgraphConfig.nethVaultAddress)
  .replaceAll("__LENDING_POOL_ADDRESS__", nextSubgraphConfig.lendingPoolAddress)
  .replaceAll("__NUSD_ADDRESS__", nextSubgraphConfig.nusdAddress)
  .replaceAll("__FACTORY_START_BLOCK__", String(nextSubgraphConfig.factoryStartBlock))
  .replaceAll("__GAUGE_FACTORY_START_BLOCK__", String(nextSubgraphConfig.gaugeFactoryStartBlock))
  .replaceAll(
    "__SYNTH_FEE_GAUGE_FACTORY_START_BLOCK__",
    String(nextSubgraphConfig.synthFeeGaugeFactoryStartBlock),
  )
  .replaceAll("__NBTC_VAULT_START_BLOCK__", String(nextSubgraphConfig.nbtcVaultStartBlock))
  .replaceAll("__NETH_VAULT_START_BLOCK__", String(nextSubgraphConfig.nethVaultStartBlock))
  .replaceAll("__LENDING_POOL_START_BLOCK__", String(nextSubgraphConfig.lendingPoolStartBlock));
if (/__[A-Z0-9_]+__/.test(subgraphManifest)) throw new Error("Subgraph template contains unresolved placeholders");

const finalizedPrediction = {
  ...prediction,
  broadcasted: true,
  status: "synth-safety-reserve-migration-staged",
  deploymentBlock: String(deploymentBlock),
  finalizedAt,
  transactionHashes: hashes,
  activationRequired: true,
  activationCompleted: false,
};

writeJson(subgraphConfigPath, nextSubgraphConfig);
atomicWriteFile(subgraphManifestPath, subgraphManifest);
writeJson(predictionPath, finalizedPrediction);
writePublicEnvironment({ root, deployment: nextDeployment, network: nextNetwork, rpcUrl });
writeJson(networkPath, nextNetwork);
// latest.json is the local commit marker. All preceding writes are idempotent,
// so --finalize-only repairs a local crash without replaying transactions.
writeJson(latestPath, nextDeployment);

console.log(JSON.stringify({
  status: finalizedPrediction.status,
  chainId,
  deploymentBlock: String(deploymentBlock),
  dexRouter: addresses.dexRouter,
  synthFeeGaugeFactory: addresses.synthFeeGaugeFactory,
  synthSafetyReserve: addresses.reserve,
  nBTC: addresses.nBTC,
  nETH: addresses.nETH,
  transactionCount: hashes.length,
  sponsorshipActive: false,
  userNusdMoved: "0",
  activationRequired: true,
  riskActionsEnabled: false,
}, null, 2));
