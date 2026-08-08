#!/usr/bin/env node

import process from "node:process";

import { parseAbi, parseAbiItem, zeroAddress } from "viem";

import {
  loadRuntime,
  requiredAddress,
  root,
  saveRuntime,
  sendContract,
} from "./lib/graduation-runtime.mjs";
import {
  CURRENT_LENDING_IMPLEMENTATION_ID,
  lendingCollateralConfigurationMatches,
  lendingRuntimeState,
} from "./lib/lending-implementation.mjs";
import { writePublicEnvironment } from "./lib/public-environment.mjs";

const broadcast = process.argv.includes("--broadcast");
if (process.argv.some((argument) => argument.startsWith("--") && argument !== "--broadcast")) {
  throw new Error(
    "Usage: npm run lending:fixed-rate:activate:check or npm run lending:fixed-rate:activate",
  );
}

const runtime = loadRuntime({ wallet: broadcast });
const { deployment, network, publicClient, account } = runtime;
const chainId = await publicClient.getChainId();
if (chainId !== Number(network.chainId) || chainId !== Number(deployment.chainId)) {
  throw new Error(`Wrong chain: expected ${network.chainId}, received ${chainId}`);
}

const migration = deployment.lendingFixedRateMigration;
if (!migration) throw new Error("The fixed-rate lending migration has not been finalized");
const lendingPool = requiredAddress(deployment.lendingPool, "lending pool");
const recordedPool = requiredAddress(migration.pool, "recorded fixed-rate lending pool");
if (recordedPool.toLowerCase() !== lendingPool.toLowerCase()) {
  throw new Error("The fixed-rate migration record does not match the active lending pool");
}

const expectedOwner = requiredAddress(deployment.deployer, "deployment owner");
const poolAbi = parseAbi([
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
  "function supplyCapNusd() view returns (uint256)",
  "function borrowCapNusd() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function totalSupplied() view returns (uint256)",
  "function totalAssetsNusd() view returns (uint256)",
  "function totalBorrowed() view returns (uint256)",
  "function totalBadDebtNusd() view returns (uint256)",
  "function collateralAssetCount() view returns (uint256)",
  "function collateralAssetAt(uint256) view returns (address)",
  "function totalCollateralByAsset(address) view returns (uint256)",
  "function collateralConfigs(address) view returns (address,uint256,uint16,uint16,uint16,uint8,bool,uint16)",
  "function activateRiskOperations()",
]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const oracleAbi = parseAbi(["function isFresh() view returns (bool)"]);
const marketActivatedEvent = parseAbiItem("event MarketActivated()");

const readPool = (functionName, args = []) => publicClient.readContract({
  address: lendingPool,
  abi: poolAbi,
  functionName,
  args,
});

let [
  owner,
  pendingOwner,
  guardian,
  nusd,
  implementationId,
  activated,
  bootstrapOpen,
  supplyPaused,
  borrowPaused,
  collateralWithdrawalPaused,
  supplyCap,
  borrowCap,
  totalSupply,
  totalSupplied,
  totalAssets,
  totalBorrowed,
  totalBadDebt,
  collateralAssetCount,
] = await Promise.all([
  readPool("owner"),
  readPool("pendingOwner"),
  readPool("guardian"),
  readPool("nusd"),
  readPool("IMPLEMENTATION_ID"),
  readPool("activated"),
  readPool("bootstrapOpen"),
  readPool("supplyPaused"),
  readPool("borrowPaused"),
  readPool("collateralWithdrawalPaused"),
  readPool("supplyCapNusd"),
  readPool("borrowCapNusd"),
  readPool("totalSupply"),
  readPool("totalSupplied"),
  readPool("totalAssetsNusd"),
  readPool("totalBorrowed"),
  readPool("totalBadDebtNusd"),
  readPool("collateralAssetCount"),
]);

const implementation = lendingRuntimeState(deployment, implementationId);
if (!implementation.runtimeCompatible || implementationId.toLowerCase() !== CURRENT_LENDING_IMPLEMENTATION_ID) {
  throw new Error("The active lending pool is not the reviewed fixed-rate implementation");
}
if (owner.toLowerCase() !== expectedOwner.toLowerCase()) {
  throw new Error(`Lending activation requires current owner ${owner}`);
}
if (pendingOwner.toLowerCase() !== zeroAddress) throw new Error("Lending pool has a pending owner");
if (guardian.toLowerCase() !== requiredAddress(deployment.guardian, "guardian").toLowerCase()) {
  throw new Error("Lending guardian does not match the deployment manifest");
}
if (nusd.toLowerCase() !== requiredAddress(deployment.nusd, "NUSD").toLowerCase()) {
  throw new Error("Lending pool NUSD binding does not match the deployment manifest");
}
if (account && account.address.toLowerCase() !== owner.toLowerCase()) {
  throw new Error(`Configured wallet ${account.address} is not lending owner ${owner}`);
}
if (supplyCap !== BigInt(deployment.lendingSupplyCapNusd)
  || borrowCap !== BigInt(deployment.lendingBorrowCapNusd)) {
  throw new Error("Lending caps do not match the deployment manifest");
}
const synthMigration = deployment.synthSafetyReserveMigration;
if (!synthMigration) {
  throw new Error("Synth migration must be finalized and activated before lending activation");
}
const synthVaultAbi = parseAbi([
  "function activated() view returns (bool)",
  "function mintPaused() view returns (bool)",
  "function withdrawPaused() view returns (bool)",
]);
const gaugeAbi = parseAbi(["function depositsPaused() view returns (bool)"]);
const [nbtcVaultActive, nbtcMintPaused, nbtcWithdrawPaused,
  nethVaultActive, nethMintPaused, nethWithdrawPaused,
  nbtcGaugePaused, nethGaugePaused] = await Promise.all([
  publicClient.readContract({ address: requiredAddress(deployment.nBTCVault, "nBTC vault"), abi: synthVaultAbi, functionName: "activated" }),
  publicClient.readContract({ address: requiredAddress(deployment.nBTCVault, "nBTC vault"), abi: synthVaultAbi, functionName: "mintPaused" }),
  publicClient.readContract({ address: requiredAddress(deployment.nBTCVault, "nBTC vault"), abi: synthVaultAbi, functionName: "withdrawPaused" }),
  publicClient.readContract({ address: requiredAddress(deployment.nETHVault, "nETH vault"), abi: synthVaultAbi, functionName: "activated" }),
  publicClient.readContract({ address: requiredAddress(deployment.nETHVault, "nETH vault"), abi: synthVaultAbi, functionName: "mintPaused" }),
  publicClient.readContract({ address: requiredAddress(deployment.nETHVault, "nETH vault"), abi: synthVaultAbi, functionName: "withdrawPaused" }),
  publicClient.readContract({ address: requiredAddress(deployment.nBTCNusdGauge, "nBTC gauge"), abi: gaugeAbi, functionName: "depositsPaused" }),
  publicClient.readContract({ address: requiredAddress(deployment.nETHNusdGauge, "nETH gauge"), abi: gaugeAbi, functionName: "depositsPaused" }),
]);
if (
  deployment.synthRiskActivationStatus !== "active"
    || deployment.synthRiskActionsEnabled !== true
    || network.deployment?.synthRiskActivationStatus !== "active"
    || network.deployment?.synthRiskActionsEnabled !== true
    || !nbtcVaultActive || nbtcMintPaused || nbtcWithdrawPaused
    || !nethVaultActive || nethMintPaused || nethWithdrawPaused
    || nbtcGaugePaused || nethGaugePaused
) throw new Error("Synth markets must be fully activated and published before lending activation");

const collateralRows = [
  ["wzkLTC", deployment.wzkLTC, deployment.ltcOracle, deployment.wzkLtcCollateralCap, true],
  ["retired nBTC", synthMigration.previousNBTC, deployment.btcOracle, deployment.nBTCLendingCollateralCap || deployment.nBTCDebtCeiling, false],
  ["retired nETH", synthMigration.previousNETH, deployment.ethOracle, deployment.nETHLendingCollateralCap || deployment.nETHDebtCeiling, false],
  ["nBTC", deployment.nBTC, deployment.btcOracle, deployment.nBTCLendingCollateralCap || deployment.nBTCDebtCeiling, true],
  ["nETH", deployment.nETH, deployment.ethOracle, deployment.nETHLendingCollateralCap || deployment.nETHDebtCeiling, true],
];
if (collateralAssetCount !== BigInt(collateralRows.length)) {
  throw new Error(`Lending collateral count is not exactly ${collateralRows.length}`);
}
const collateralDefinitions = collateralRows.map(([symbol, asset, oracle, cap, enabled]) => ({
  symbol,
  asset: requiredAddress(asset, `${symbol} asset`),
  oracle: requiredAddress(oracle, `${symbol} oracle`),
  cap: BigInt(cap),
  enabled,
}));
const collateralOrder = await Promise.all(collateralDefinitions.map((_, index) => (
  readPool("collateralAssetAt", [BigInt(index)])
)));
for (const [index, definition] of collateralDefinitions.entries()) {
  if (collateralOrder[index].toLowerCase() !== definition.asset.toLowerCase()) {
    throw new Error(`Lending collateral order mismatch at ${definition.symbol}`);
  }
}

const collateralState = [];
for (const definition of collateralDefinitions) {
  const [config, oracleFresh, deposited] = await Promise.all([
    readPool("collateralConfigs", [definition.asset]),
    publicClient.readContract({
      address: definition.oracle,
      abi: oracleAbi,
      functionName: "isFresh",
    }),
    readPool("totalCollateralByAsset", [definition.asset]),
  ]);
  if (!lendingCollateralConfigurationMatches(config, definition)) {
    throw new Error(`${definition.symbol} collateral configuration is not activation-ready`);
  }
  if (!oracleFresh) throw new Error(`${definition.symbol} oracle is stale`);
  collateralState.push({ ...definition, oracleFresh, deposited });
}

const cash = await publicClient.readContract({
  address: nusd,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [lendingPool],
});
const staged = !activated
  && !bootstrapOpen
  && supplyPaused
  && borrowPaused
  && collateralWithdrawalPaused;
const liveEnabled = activated
  && !bootstrapOpen
  && !supplyPaused
  && !borrowPaused
  && !collateralWithdrawalPaused;

if (!staged && !liveEnabled) {
  throw new Error("Lending pool is neither safely staged nor fully active");
}
if (staged) {
  const migratedNusd = BigInt(migration.migratedNusd);
  if (
    totalSupply !== migratedNusd
      || totalSupplied !== migratedNusd
      || totalAssets !== migratedNusd
      || cash !== migratedNusd
      || totalBorrowed !== 0n
      || totalBadDebt !== 0n
      || collateralState.some((item) => item.deposited !== 0n)
  ) throw new Error("Staged lending accounting is not safe to activate");

  await publicClient.simulateContract({
    account: account || owner,
    address: lendingPool,
    abi: poolAbi,
    functionName: "activateRiskOperations",
  });
}

const publicationReady = deployment.lendingFixedRateActivationStatus === "active"
  && deployment.lendingRiskActionsEnabled === true
  && network.deployment?.lendingFixedRateActivationStatus === "active"
  && network.deployment?.lendingRiskActionsEnabled === true;

if (!broadcast) {
  console.log(JSON.stringify({
    mode: "check",
    chainId,
    lendingPool,
    implementationId,
    staged,
    activated,
    liveRiskActionsEnabled: liveEnabled,
    publicationReady,
    readyToActivate: staged,
    publicationRepairRequired: liveEnabled && !publicationReady,
    accounting: {
      totalSupply,
      totalSupplied,
      totalAssets,
      totalBorrowed,
      totalBadDebt,
      cash,
    },
    collateral: collateralState.map((item) => ({
      symbol: item.symbol,
      oracleFresh: item.oracleFresh,
      deposited: item.deposited,
    })),
  }, (key, value) => typeof value === "bigint" ? value.toString() : value, 2));
  if (liveEnabled && !publicationReady) process.exitCode = 1;
  process.exit();
}

let activationHash;
let activationReceipt;
if (staged) {
  const result = await sendContract(runtime, lendingPool, poolAbi, "activateRiskOperations");
  activationHash = result.hash;
  activationReceipt = result.receipt;
}

[
  activated,
  bootstrapOpen,
  supplyPaused,
  borrowPaused,
  collateralWithdrawalPaused,
] = await Promise.all([
  readPool("activated"),
  readPool("bootstrapOpen"),
  readPool("supplyPaused"),
  readPool("borrowPaused"),
  readPool("collateralWithdrawalPaused"),
]);
if (!activated || bootstrapOpen || supplyPaused || borrowPaused || collateralWithdrawalPaused) {
  throw new Error("Lending activation post-state verification failed");
}

const recordedHash = deployment.lendingFixedRateActivation?.transactionHash;
const fromBlock = BigInt(migration.block || deployment.deploymentBlock);
const activationLogs = await publicClient.getLogs({
  address: lendingPool,
  event: marketActivatedEvent,
  fromBlock,
  toBlock: "latest",
});
const preferredHash = activationHash
  || (/^0x[0-9a-fA-F]{64}$/.test(recordedHash || "") ? recordedHash : undefined);
const activationLog = preferredHash
  ? activationLogs.find((log) => log.transactionHash?.toLowerCase() === preferredHash.toLowerCase())
  : activationLogs.at(-1);
if (!activationLog?.transactionHash) {
  throw new Error("Active lending pool has no receipt-backed MarketActivated event evidence");
}
activationHash = activationLog.transactionHash;
if (!activationReceipt || activationReceipt.transactionHash.toLowerCase() !== activationHash.toLowerCase()) {
  activationReceipt = await publicClient.getTransactionReceipt({ hash: activationHash });
}
if (activationReceipt.status !== "success") throw new Error("Lending activation receipt reverted");
if (activationReceipt.to?.toLowerCase() !== lendingPool.toLowerCase()) {
  throw new Error("Lending activation receipt targets a different contract");
}
const activationBlock = await publicClient.getBlock({ blockNumber: activationReceipt.blockNumber });
const activatedAt = new Date(Number(activationBlock.timestamp) * 1000).toISOString();
const activationRecord = {
  pool: lendingPool,
  block: activationReceipt.blockNumber.toString(),
  activatedAt,
  transactionHash: activationHash,
};

deployment.lendingFixedRateActivation = activationRecord;
deployment.lendingFixedRateActivationStatus = "active";
deployment.lendingRiskActionsEnabled = true;
deployment.lendingFixedRateMigration = {
  ...migration,
  activationRequired: false,
  activationCompleted: true,
  activationBlock: activationRecord.block,
  activationHash,
  activatedAt,
};
deployment.transactionHashes = [...new Set([
  ...(deployment.transactionHashes || []),
  activationHash,
])];
network.deployment = {
  ...network.deployment,
  lendingFixedRateMigration: deployment.lendingFixedRateMigration,
  lendingFixedRateActivation: activationRecord,
  lendingFixedRateActivationStatus: "active",
  lendingRiskActionsEnabled: true,
  contracts: {
    ...network.deployment?.contracts,
    lendingPool,
  },
};

saveRuntime(network, deployment);
writePublicEnvironment({
  root,
  deployment,
  network,
  rpcUrl: (process.env.LITEFORGE_RPC_URL || network.rpcUrl).trim(),
});

console.log(JSON.stringify({
  mode: staged ? "broadcast" : "publication-repair",
  chainId,
  lendingPool,
  activated: true,
  riskActionsEnabled: true,
  transactionSent: staged,
  transactionHash: activationHash,
  activationBlock: activationRecord.block,
  activatedAt,
}, null, 2));
