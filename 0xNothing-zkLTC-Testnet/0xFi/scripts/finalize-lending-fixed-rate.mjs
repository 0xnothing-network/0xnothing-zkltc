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
  keccak256,
  parseAbi,
  stringToHex,
  zeroAddress,
} from "viem";

import { atomicWriteFile } from "./lib/graduation-runtime.mjs";
import { creationInputMatchesArtifact } from "./lib/lending-implementation.mjs";
import { writePublicEnvironment } from "./lib/public-environment.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });

const CHAIN_ID = 4441;
const LOCKED_SHARE_RECIPIENT = "0x0000000000000000000000000000000000000001";
const IMPLEMENTATION_STATUS = "fixed-rate-protocol-spread-80-85-90-paused-bootstrap-v2";
const IMPLEMENTATION_ID = keccak256(
  stringToHex("0xfi.lending.fixed-4.5-4-0.5.80-85-90.paused-bootstrap.v2"),
);
const BORROW_APR_BPS = 450n;
const LENDER_APR_BPS = 400n;
const PROTOCOL_APR_BPS = 50n;
const LOAN_TO_VALUE_BPS = 8000n;
const MARGIN_CALL_THRESHOLD_BPS = 8500n;
const LIQUIDATION_THRESHOLD_BPS = 9000n;
const LIQUIDATION_BONUS_BPS = 500n;
const BORROW_RATE_WAD = 45_000_000_000_000_000n;
const LENDER_RATE_WAD = 40_000_000_000_000_000n;
const PROTOCOL_RATE_WAD = 5_000_000_000_000_000n;
const predictionPath = path.join(root, "contracts", "deployments", "lending-fixed-rate.json");
const latestPath = path.join(root, "contracts", "deployments", "latest.json");
const networkPath = path.join(root, "config", "liteforge-testnet.json");
const subgraphConfigPath = path.join(root, "subgraph", "subgraph.config.json");
const subgraphTemplatePath = path.join(root, "subgraph", "subgraph.template.yaml");
const subgraphManifestPath = path.join(root, "subgraph", "subgraph.yaml");
const broadcastPath = path.join(
  root,
  "contracts",
  "broadcast",
  "MigrateLendingFixedRate.s.sol",
  String(CHAIN_ID),
  "run-latest.json",
);
const artifactPath = path.join(
  root,
  "contracts",
  "out",
  "PooledNUSDLendingPool.sol",
  "PooledNUSDLendingPool.json",
);

for (const [label, file] of [
  ["migration prediction", predictionPath],
  ["active deployment", latestPath],
  ["network config", networkPath],
  ["broadcast journal", broadcastPath],
  ["lending artifact", artifactPath],
  ["subgraph config", subgraphConfigPath],
  ["subgraph template", subgraphTemplatePath],
]) {
  if (!fs.existsSync(file)) throw new Error(`${label} is missing: ${file}`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function address(value, label) {
  if (!isAddress(value)) throw new Error(`${label} is not a valid address`);
  return getAddress(value);
}

function uint(value, label) {
  try {
    const parsed = BigInt(String(value));
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${label} is not an unsigned integer`);
  }
}

function bytes32(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} is not bytes32`);
  return normalized;
}

function sameAddress(left, right) {
  return address(left, "address").toLowerCase() === address(right, "address").toLowerCase();
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

function requireAddress(actual, expected, label) {
  if (!sameAddress(actual, expected)) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

function writeJson(file, value) {
  atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

const prediction = readJson(predictionPath);
const previous = readJson(latestPath);
const network = readJson(networkPath);
const broadcast = readJson(broadcastPath);
const artifact = readJson(artifactPath);
const subgraphConfig = readJson(subgraphConfigPath);

if (Number(prediction.chainId) !== CHAIN_ID) throw new Error("Migration prediction has the wrong chain ID");
if (prediction.implementationStatus !== IMPLEMENTATION_STATUS) {
  throw new Error("Migration prediction does not target the current lending implementation");
}
requireEqual(prediction.activationRequired, true, "prediction activation requirement");

const deployer = address(prediction.deployer, "deployer");
const oldPool = address(prediction.oldLendingPool, "old lending pool");
const newPool = address(prediction.newLendingPool || prediction.lendingPool, "new lending pool");
const nusd = address(previous.nusd, "NUSD");
const wzkLtc = address(previous.wzkLTC, "WzkLTC");
const nbtc = address(previous.nBTC, "nBTC");
const neth = address(previous.nETH, "nETH");
const ltcOracle = address(previous.ltcOracle, "LTC oracle");
const btcOracle = address(previous.btcOracle, "BTC oracle");
const ethOracle = address(previous.ethOracle, "ETH oracle");

requireAddress(previous.deployer, deployer, "deployment owner");

function requireRecoverablePoolReference(actual, migration, label) {
  if (sameAddress(actual, oldPool)) return;
  if (!sameAddress(actual, newPool)) {
    throw new Error(`${label}: expected ${oldPool} or ${newPool}, got ${actual}`);
  }
  requireAddress(migration?.previousPool, oldPool, `${label} staged previous pool`);
  requireAddress(migration?.pool, newPool, `${label} staged replacement pool`);
}

requireRecoverablePoolReference(
  previous.lendingPool,
  previous.lendingFixedRateMigration,
  "top-level lending pool",
);
requireRecoverablePoolReference(
  previous.contracts?.lendingPool,
  previous.lendingFixedRateMigration,
  "nested lending pool",
);
requireRecoverablePoolReference(
  network.deployment?.contracts?.lendingPool,
  network.deployment?.lendingFixedRateMigration,
  "network lending pool",
);
if (previous.lendingRiskActionsEnabled === true) {
  throw new Error("The fixed-rate lending pool is already activated; refusing to restage it");
}

const migratedNusd = uint(prediction.migratedNusd, "migrated NUSD");
const oldTotalBefore = uint(prediction.oldTotalSuppliedBefore, "old total supplied before migration");
const lockedShares = uint(prediction.oldLockedShares, "old locked shares");
const residualNusd = uint(prediction.oldResidualNusd, "old residual NUSD");
const supplyCap = uint(prediction.newSupplyCapNusd, "new supply cap");
const borrowCap = uint(prediction.newBorrowCapNusd, "new borrow cap");
const implementationId = bytes32(prediction.implementationId, "implementation ID");
const borrowAprBps = uint(prediction.borrowAprBps, "borrow APR");
const lenderAprBps = uint(prediction.lenderAprBps, "lender APR");
const protocolAprBps = uint(prediction.protocolAprBps, "protocol APR");
const loanToValueBps = uint(prediction.loanToValueBps, "loan-to-value ratio");
const marginCallThresholdBps = uint(prediction.marginCallThresholdBps, "margin-call threshold");
const liquidationThresholdBps = uint(prediction.liquidationThresholdBps, "liquidation threshold");
const liquidationBonusBps = uint(prediction.liquidationBonusBps, "liquidation bonus");
requireEqual(implementationId, IMPLEMENTATION_ID, "prediction implementation ID");
requireEqual(borrowAprBps, BORROW_APR_BPS, "prediction borrow APR");
requireEqual(lenderAprBps, LENDER_APR_BPS, "prediction lender APR");
requireEqual(protocolAprBps, PROTOCOL_APR_BPS, "prediction protocol APR");
requireEqual(loanToValueBps, LOAN_TO_VALUE_BPS, "prediction LTV");
requireEqual(marginCallThresholdBps, MARGIN_CALL_THRESHOLD_BPS, "prediction margin-call threshold");
requireEqual(liquidationThresholdBps, LIQUIDATION_THRESHOLD_BPS, "prediction liquidation threshold");
requireEqual(liquidationBonusBps, LIQUIDATION_BONUS_BPS, "prediction liquidation bonus");
requireEqual(oldTotalBefore, migratedNusd + residualNusd, "migration asset conservation");
requireEqual(lockedShares, residualNusd, "locked-share residual");

const creates = (broadcast.transactions || []).filter((transaction) => (
  transaction.transactionType === "CREATE" && transaction.contractName === "PooledNUSDLendingPool"
));
if (creates.length !== 1) throw new Error("Broadcast journal must contain exactly one lending-pool creation");
requireAddress(creates[0].contractAddress, newPool, "created lending pool");
if (!creationInputMatchesArtifact(creates[0].transaction?.input, artifact.bytecode?.object)) {
  throw new Error("Created lending pool does not match the current compiled artifact");
}

const hashes = [...new Set((broadcast.transactions || [])
  .map((transaction) => transaction.hash)
  .filter((hash) => /^0x[0-9a-fA-F]{64}$/.test(hash || "")))];
if (hashes.length !== 9 || hashes.length !== (broadcast.transactions || []).length) {
  throw new Error(`Expected exactly 9 uniquely hashed migration transactions, got ${hashes.length}`);
}
for (const transaction of broadcast.transactions || []) {
  const sender = transaction.transaction?.from;
  if (sender) requireAddress(sender, deployer, `sender for ${transaction.hash}`);
}

const rpcUrl = (process.env.LITEFORGE_RPC_URL || network.rpcUrl).trim();
const fallbackUrl = (process.env.LITEFORGE_FALLBACK_RPC_URL || network.fallbackRpcUrl).trim();
const client = createPublicClient({ transport: fallback([http(rpcUrl), http(fallbackUrl)]) });
const chainId = await client.getChainId();
if (chainId !== CHAIN_ID) throw new Error(`Wrong chain: expected ${CHAIN_ID}, got ${chainId}`);

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
for (const transaction of broadcast.transactions || []) {
  const receipt = receiptByHash.get(transaction.hash.toLowerCase());
  if (!receipt) throw new Error(`Missing receipt evidence for ${transaction.hash}`);
  requireAddress(receipt.from, deployer, `receipt sender for ${transaction.hash}`);
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
const createReceipt = receipts.find((receipt) => receipt.transactionHash.toLowerCase() === creates[0].hash.toLowerCase());
if (!createReceipt?.contractAddress) throw new Error("Lending deployment receipt has no contract address");
requireAddress(createReceipt.contractAddress, newPool, "deployment receipt contract");
const deploymentBlock = createReceipt.blockNumber;

const code = await client.getCode({ address: newPool });
if (!code || code === "0x") throw new Error(`No bytecode at ${newPool}`);

const poolAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function guardian() view returns (address)",
  "function nusd() view returns (address)",
  "function supplyCapNusd() view returns (uint256)",
  "function borrowCapNusd() view returns (uint256)",
  "function IMPLEMENTATION_ID() view returns (bytes32)",
  "function BORROW_APR_BPS() view returns (uint256)",
  "function LENDER_APR_BPS() view returns (uint256)",
  "function PROTOCOL_APR_BPS() view returns (uint256)",
  "function borrowRate() view returns (uint256)",
  "function lenderRate() view returns (uint256)",
  "function protocolRate() view returns (uint256)",
  "function accruedProtocolInterestNusd() view returns (uint256)",
  "function activated() view returns (bool)",
  "function bootstrapOpen() view returns (bool)",
  "function supplyPaused() view returns (bool)",
  "function borrowPaused() view returns (bool)",
  "function collateralWithdrawalPaused() view returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function totalSupplied() view returns (uint256)",
  "function totalAssetsNusd() view returns (uint256)",
  "function totalBorrowed() view returns (uint256)",
  "function totalBadDebtNusd() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function collateralAssetCount() view returns (uint256)",
  "function collateralAssetAt(uint256) view returns (address)",
  "function totalCollateralByAsset(address) view returns (uint256)",
  "function collateralConfigs(address) view returns (address,uint256,uint16,uint16,uint16,uint8,bool,uint16)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);
const oracleAbi = parseAbi([
  "function readPriceWad() view returns (uint256,uint256,uint80)",
]);

const readPool = (pool, functionName, args = []) => client.readContract({
  address: pool,
  abi: poolAbi,
  functionName,
  args,
});
const readToken = (functionName, args) => client.readContract({
  address: nusd,
  abi: erc20Abi,
  functionName,
  args,
});

const [
  newOwner,
  newPendingOwner,
  newGuardian,
  newNusd,
  newSupplyCap,
  newBorrowCap,
  newImplementationId,
  newBorrowAprBps,
  newLenderAprBps,
  newProtocolAprBps,
  newBorrowRate,
  newLenderRate,
  newProtocolRate,
  newAccruedProtocolInterest,
  newActivated,
  newBootstrapOpen,
  newSupplyPaused,
  newBorrowPaused,
  newWithdrawalPaused,
  newTotalShares,
  newTotalSupplied,
  newTotalAssets,
  newBorrowed,
  newBadDebt,
  newDeployerShares,
  newLockedShares,
  newCollateralCount,
  newAsset0,
  newAsset1,
  newAsset2,
  newWzkLtcCollateral,
  newNbtcCollateral,
  newNethCollateral,
  newWzkLtcConfig,
  newNbtcConfig,
  newNethConfig,
  newCash,
  newAllowance,
] = await Promise.all([
  readPool(newPool, "owner"),
  readPool(newPool, "pendingOwner"),
  readPool(newPool, "guardian"),
  readPool(newPool, "nusd"),
  readPool(newPool, "supplyCapNusd"),
  readPool(newPool, "borrowCapNusd"),
  readPool(newPool, "IMPLEMENTATION_ID"),
  readPool(newPool, "BORROW_APR_BPS"),
  readPool(newPool, "LENDER_APR_BPS"),
  readPool(newPool, "PROTOCOL_APR_BPS"),
  readPool(newPool, "borrowRate"),
  readPool(newPool, "lenderRate"),
  readPool(newPool, "protocolRate"),
  readPool(newPool, "accruedProtocolInterestNusd"),
  readPool(newPool, "activated"),
  readPool(newPool, "bootstrapOpen"),
  readPool(newPool, "supplyPaused"),
  readPool(newPool, "borrowPaused"),
  readPool(newPool, "collateralWithdrawalPaused"),
  readPool(newPool, "totalSupply"),
  readPool(newPool, "totalSupplied"),
  readPool(newPool, "totalAssetsNusd"),
  readPool(newPool, "totalBorrowed"),
  readPool(newPool, "totalBadDebtNusd"),
  readPool(newPool, "balanceOf", [deployer]),
  readPool(newPool, "balanceOf", [LOCKED_SHARE_RECIPIENT]),
  readPool(newPool, "collateralAssetCount"),
  readPool(newPool, "collateralAssetAt", [0n]),
  readPool(newPool, "collateralAssetAt", [1n]),
  readPool(newPool, "collateralAssetAt", [2n]),
  readPool(newPool, "totalCollateralByAsset", [wzkLtc]),
  readPool(newPool, "totalCollateralByAsset", [nbtc]),
  readPool(newPool, "totalCollateralByAsset", [neth]),
  readPool(newPool, "collateralConfigs", [wzkLtc]),
  readPool(newPool, "collateralConfigs", [nbtc]),
  readPool(newPool, "collateralConfigs", [neth]),
  readToken("balanceOf", [newPool]),
  readToken("allowance", [deployer, newPool]),
]);

requireAddress(newOwner, deployer, "new pool owner");
requireAddress(newPendingOwner, zeroAddress, "new pool pending owner");
requireAddress(newGuardian, deployer, "new pool guardian");
requireAddress(newNusd, nusd, "new pool NUSD binding");
requireEqual(newSupplyCap, supplyCap, "new pool supply cap");
requireEqual(newBorrowCap, borrowCap, "new pool borrow cap");
requireEqual(newImplementationId.toLowerCase(), implementationId, "new pool implementation ID");
requireEqual(newBorrowAprBps, borrowAprBps, "new pool borrow APR");
requireEqual(newLenderAprBps, lenderAprBps, "new pool lender APR");
requireEqual(newProtocolAprBps, protocolAprBps, "new pool protocol APR");
requireEqual(newBorrowRate, BORROW_RATE_WAD, "new pool borrow rate");
requireEqual(newLenderRate, LENDER_RATE_WAD, "new pool lender rate");
requireEqual(newProtocolRate, PROTOCOL_RATE_WAD, "new pool protocol rate");
requireEqual(newAccruedProtocolInterest, 0n, "new pool accrued protocol interest");
requireEqual(newActivated, false, "new pool activation state");
requireEqual(newBootstrapOpen, false, "new pool bootstrap state");
requireEqual(newSupplyPaused, true, "new pool supply pause");
requireEqual(newBorrowPaused, true, "new pool borrow pause");
requireEqual(newWithdrawalPaused, true, "new pool collateral-withdrawal pause");
requireEqual(newTotalShares, migratedNusd, "new pool total shares");
requireEqual(newTotalSupplied, migratedNusd, "new pool total supplied");
requireEqual(newTotalAssets, migratedNusd, "new pool total assets");
requireEqual(newBorrowed, 0n, "new pool debt");
requireEqual(newBadDebt, 0n, "new pool bad debt");
requireEqual(newDeployerShares, migratedNusd - lockedShares, "new deployer shares");
requireEqual(newLockedShares, lockedShares, "new locked shares");
requireEqual(newCollateralCount, 3n, "new collateral count");
requireAddress(newAsset0, wzkLtc, "new collateral asset 0");
requireAddress(newAsset1, nbtc, "new collateral asset 1");
requireAddress(newAsset2, neth, "new collateral asset 2");
requireEqual(newWzkLtcCollateral, 0n, "new WzkLTC collateral balance");
requireEqual(newNbtcCollateral, 0n, "new nBTC collateral balance");
requireEqual(newNethCollateral, 0n, "new nETH collateral balance");
requireEqual(newCash, migratedNusd, "new pool NUSD cash");
requireEqual(newAllowance, 0n, "new pool residual deployer allowance");

function verifyCollateral(config, expectedOracle, expectedCap, label) {
  requireAddress(config[0], expectedOracle, `${label} oracle`);
  requireEqual(config[1], expectedCap, `${label} cap`);
  requireEqual(config[2], Number(loanToValueBps), `${label} LTV`);
  requireEqual(config[3], Number(liquidationThresholdBps), `${label} liquidation threshold`);
  requireEqual(config[4], Number(liquidationBonusBps), `${label} liquidation bonus`);
  requireEqual(config[5], 18, `${label} decimals`);
  requireEqual(config[6], true, `${label} enabled`);
  requireEqual(config[7], Number(marginCallThresholdBps), `${label} margin-call threshold`);
}
verifyCollateral(newWzkLtcConfig, ltcOracle, uint(prediction.wzkLtcCollateralCap, "WzkLTC cap"), "WzkLTC");
verifyCollateral(newNbtcConfig, btcOracle, uint(prediction.nBTCCollateralCap, "nBTC cap"), "nBTC");
verifyCollateral(newNethConfig, ethOracle, uint(prediction.nETHCollateralCap, "nETH cap"), "nETH");

const [
  oldOwner,
  oldNusd,
  oldSupplyPaused,
  oldBorrowPaused,
  oldWithdrawalPaused,
  oldTotalShares,
  oldTotalSupplied,
  oldBorrowed,
  oldBadDebt,
  oldDeployerShares,
  oldLockedShares,
  oldWzkLtcCollateral,
  oldNbtcCollateral,
  oldNethCollateral,
  oldCash,
] = await Promise.all([
  readPool(oldPool, "owner"),
  readPool(oldPool, "nusd"),
  readPool(oldPool, "supplyPaused"),
  readPool(oldPool, "borrowPaused"),
  readPool(oldPool, "collateralWithdrawalPaused"),
  readPool(oldPool, "totalSupply"),
  readPool(oldPool, "totalSupplied"),
  readPool(oldPool, "totalBorrowed"),
  readPool(oldPool, "totalBadDebtNusd"),
  readPool(oldPool, "balanceOf", [deployer]),
  readPool(oldPool, "balanceOf", [LOCKED_SHARE_RECIPIENT]),
  readPool(oldPool, "totalCollateralByAsset", [wzkLtc]),
  readPool(oldPool, "totalCollateralByAsset", [nbtc]),
  readPool(oldPool, "totalCollateralByAsset", [neth]),
  readToken("balanceOf", [oldPool]),
]);
requireAddress(oldOwner, deployer, "retired pool owner");
requireAddress(oldNusd, nusd, "retired pool NUSD binding");
requireEqual(oldSupplyPaused, true, "retired pool supply pause");
requireEqual(oldBorrowPaused, true, "retired pool borrow pause");
requireEqual(oldWithdrawalPaused, true, "retired pool collateral-withdrawal pause");
requireEqual(oldTotalShares, lockedShares, "retired pool total shares");
requireEqual(oldTotalSupplied, residualNusd, "retired pool residual assets");
requireEqual(oldBorrowed, 0n, "retired pool debt");
requireEqual(oldBadDebt, 0n, "retired pool bad debt");
requireEqual(oldDeployerShares, 0n, "retired deployer shares");
requireEqual(oldLockedShares, lockedShares, "retired locked shares");
requireEqual(oldWzkLtcCollateral, 0n, "retired WzkLTC collateral");
requireEqual(oldNbtcCollateral, 0n, "retired nBTC collateral");
requireEqual(oldNethCollateral, 0n, "retired nETH collateral");
requireEqual(oldCash, residualNusd, "retired pool NUSD cash");

const oracleSnapshots = await Promise.all([ltcOracle, btcOracle, ethOracle].map((oracle) => (
  client.readContract({ address: oracle, abi: oracleAbi, functionName: "readPriceWad" })
)));
for (const [index, snapshot] of oracleSnapshots.entries()) {
  if (snapshot[0] <= 0n || snapshot[1] <= 0n || snapshot[2] <= 0n) {
    throw new Error(`Collateral oracle ${index} returned an invalid snapshot`);
  }
}

const existingMigration = [
  previous.lendingFixedRateMigration,
  network.deployment?.lendingFixedRateMigration,
].find((migration) => (
  migration
  && sameAddress(migration.previousPool, oldPool)
  && sameAddress(migration.pool, newPool)
));
const finalizedAt = existingMigration?.finalizedAt || prediction.finalizedAt || new Date().toISOString();
const migrationRecord = {
  previousPool: oldPool,
  pool: newPool,
  block: String(deploymentBlock),
  finalizedAt,
  migratedNusd: migratedNusd.toString(),
  residualNusd: residualNusd.toString(),
  transactionHashes: hashes,
  implementationId,
  borrowAprBps: borrowAprBps.toString(),
  lenderAprBps: lenderAprBps.toString(),
  protocolAprBps: protocolAprBps.toString(),
  loanToValueBps: loanToValueBps.toString(),
  marginCallThresholdBps: marginCallThresholdBps.toString(),
  liquidationThresholdBps: liquidationThresholdBps.toString(),
  liquidationBonusBps: liquidationBonusBps.toString(),
  implementationStatus: IMPLEMENTATION_STATUS,
  activationRequired: true,
  activationCompleted: false,
};
const transactionHashes = [...new Set([...(previous.transactionHashes || []), ...hashes])];
const nextDeployment = {
  ...previous,
  lendingPool: newPool,
  lendingImplementationStatus: IMPLEMENTATION_STATUS,
  lendingImplementationMigrationRequired: false,
  lendingFixedRateMigration: migrationRecord,
  lendingFixedRateActivationStatus: "pending-owner-activation",
  lendingRiskActionsEnabled: false,
  lendingCollateralConfigurationStatus: "configured-three-assets-fixed-80-85-90",
  transactionHashes,
  contracts: { ...previous.contracts, lendingPool: newPool },
};
delete nextDeployment.lendingImplementationRequiredAction;

const nextNetwork = {
  ...network,
  deployment: {
    ...network.deployment,
    lendingImplementationStatus: IMPLEMENTATION_STATUS,
    lendingImplementationMigrationRequired: false,
    lendingFixedRateMigration: migrationRecord,
    lendingFixedRateActivationStatus: "pending-owner-activation",
    lendingRiskActionsEnabled: false,
    lendingCollateralConfigurationStatus: "configured-three-assets-fixed-80-85-90",
    contracts: { ...network.deployment.contracts, lendingPool: newPool },
  },
};
delete nextNetwork.deployment.lendingImplementationRequiredAction;

const nextSubgraphConfig = {
  ...subgraphConfig,
  lendingPoolAddress: newPool,
  lendingPoolStartBlock: Number(deploymentBlock),
};
if (!Number.isSafeInteger(nextSubgraphConfig.lendingPoolStartBlock)) {
  throw new Error("Lending deployment block is outside JavaScript's safe integer range");
}
let subgraphManifest = fs.readFileSync(subgraphTemplatePath, "utf8")
  .replaceAll("__NETWORK__", nextSubgraphConfig.network)
  .replaceAll("__FACTORY_ADDRESS__", nextSubgraphConfig.factoryAddress)
  .replaceAll("__GAUGE_FACTORY_ADDRESS__", nextSubgraphConfig.gaugeFactoryAddress)
  .replaceAll("__NBTC_VAULT_ADDRESS__", nextSubgraphConfig.nbtcVaultAddress)
  .replaceAll("__NETH_VAULT_ADDRESS__", nextSubgraphConfig.nethVaultAddress)
  .replaceAll("__LENDING_POOL_ADDRESS__", nextSubgraphConfig.lendingPoolAddress)
  .replaceAll("__NUSD_ADDRESS__", nextSubgraphConfig.nusdAddress)
  .replaceAll("__FACTORY_START_BLOCK__", String(nextSubgraphConfig.factoryStartBlock))
  .replaceAll("__GAUGE_FACTORY_START_BLOCK__", String(nextSubgraphConfig.gaugeFactoryStartBlock))
  .replaceAll("__NBTC_VAULT_START_BLOCK__", String(nextSubgraphConfig.nbtcVaultStartBlock))
  .replaceAll("__NETH_VAULT_START_BLOCK__", String(nextSubgraphConfig.nethVaultStartBlock))
  .replaceAll("__LENDING_POOL_START_BLOCK__", String(nextSubgraphConfig.lendingPoolStartBlock));
if (nextSubgraphConfig.synthFeeGaugeFactoryAddress && nextSubgraphConfig.synthFeeGaugeFactoryStartBlock !== undefined) {
  subgraphManifest = subgraphManifest
    .replaceAll("__SYNTH_FEE_GAUGE_FACTORY_ADDRESS__", nextSubgraphConfig.synthFeeGaugeFactoryAddress)
    .replaceAll(
      "__SYNTH_FEE_GAUGE_FACTORY_START_BLOCK__",
      String(nextSubgraphConfig.synthFeeGaugeFactoryStartBlock),
    );
} else {
  subgraphManifest = subgraphManifest.replace(
    /\n  # SYNTH_FEE_GAUGE_FACTORY_START\n[\s\S]*?\n  # SYNTH_FEE_GAUGE_FACTORY_END\n/,
    "\n",
  );
}
if (/__[A-Z0-9_]+__/.test(subgraphManifest)) throw new Error("Subgraph template contains unresolved placeholders");

const finalizedPrediction = {
  ...prediction,
  broadcasted: true,
  status: "lending-fixed-rate-migration-staged",
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
// latest.json is the local commit marker. Every preceding write is idempotent,
// and a crash before this point can be repaired with --finalize-only.
writeJson(latestPath, nextDeployment);

console.log(JSON.stringify({
  status: finalizedPrediction.status,
  chainId,
  previousPool: oldPool,
  lendingPool: newPool,
  deploymentBlock: String(deploymentBlock),
  migratedNusd: migratedNusd.toString(),
  residualNusd: residualNusd.toString(),
  transactionCount: hashes.length,
  activationRequired: true,
  riskActionsEnabled: false,
}, null, 2));
