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
  synthActivationLendingSafety,
} from "./lib/lending-implementation.mjs";
import { writePublicEnvironment } from "./lib/public-environment.mjs";
import { primaryRpcUrl } from "./lib/rpc.mjs";

const broadcast = process.argv.includes("--broadcast");
if (process.argv.some((argument) => argument.startsWith("--") && argument !== "--broadcast")) {
  throw new Error(
    "Usage: npm run synth:safety-reserve:activate:check or npm run synth:safety-reserve:activate",
  );
}

const runtime = loadRuntime({ wallet: broadcast });
const { deployment, network, publicClient, account } = runtime;
const chainId = await publicClient.getChainId();
if (chainId !== Number(network.chainId) || chainId !== Number(deployment.chainId)) {
  throw new Error(`Wrong chain: expected ${network.chainId}, received ${chainId}`);
}

const migration = deployment.synthSafetyReserveMigration;
if (!migration) throw new Error("The synth safety-reserve migration has not been finalized");
const owner = requiredAddress(deployment.deployer, "deployment owner");
if (account && account.address.toLowerCase() !== owner.toLowerCase()) {
  throw new Error(`Configured wallet ${account.address} is not synth owner ${owner}`);
}

const addresses = {
  nusd: requiredAddress(deployment.nusd, "NUSD"),
  factory: requiredAddress(deployment.dexFactory, "DEX factory"),
  lending: requiredAddress(deployment.lendingPool, "lending pool"),
  wzkLTC: requiredAddress(deployment.wzkLTC, "WzkLTC"),
  oldNBTC: requiredAddress(migration.previousNBTC, "retired nBTC"),
  oldNETH: requiredAddress(migration.previousNETH, "retired nETH"),
  nBTC: requiredAddress(deployment.nBTC, "nBTC"),
  nETH: requiredAddress(deployment.nETH, "nETH"),
  nBTCVault: requiredAddress(deployment.nBTCVault, "nBTC vault"),
  nETHVault: requiredAddress(deployment.nETHVault, "nETH vault"),
  nBTCNusdPair: requiredAddress(deployment.nBTCNusdPair, "nBTC/NUSD pair"),
  nETHNusdPair: requiredAddress(deployment.nETHNusdPair, "nETH/NUSD pair"),
  nBTCNusdGauge: requiredAddress(deployment.nBTCNusdGauge, "nBTC/NUSD gauge"),
  nETHNusdGauge: requiredAddress(deployment.nETHNusdGauge, "nETH/NUSD gauge"),
  reserve: requiredAddress(deployment.synthSafetyReserve, "synth safety reserve"),
  feeFactory: requiredAddress(deployment.synthFeeGaugeFactory, "synth fee gauge factory"),
  btcOracle: requiredAddress(deployment.btcOracle, "BTC oracle"),
  ethOracle: requiredAddress(deployment.ethOracle, "ETH oracle"),
  ltcOracle: requiredAddress(deployment.ltcOracle, "LTC oracle"),
};

for (const [recorded, current, label] of [
  [migration.reserve, addresses.reserve, "reserve"],
  [migration.synthFeeGaugeFactory, addresses.feeFactory, "fee factory"],
  [migration.nBTC, addresses.nBTC, "nBTC"],
  [migration.nETH, addresses.nETH, "nETH"],
  [migration.nBTCVault, addresses.nBTCVault, "nBTC vault"],
  [migration.nETHVault, addresses.nETHVault, "nETH vault"],
  [migration.nBTCNusdPair, addresses.nBTCNusdPair, "nBTC pair"],
  [migration.nETHNusdPair, addresses.nETHNusdPair, "nETH pair"],
  [migration.nBTCNusdGauge, addresses.nBTCNusdGauge, "nBTC gauge"],
  [migration.nETHNusdGauge, addresses.nETHNusdGauge, "nETH gauge"],
]) {
  if (requiredAddress(recorded, `recorded ${label}`).toLowerCase() !== current.toLowerCase()) {
    throw new Error(`Synth migration record does not match the active ${label}`);
  }
}
if (
  requiredAddress(network.deployment?.contracts?.synthSafetyReserve, "network reserve").toLowerCase()
    !== addresses.reserve.toLowerCase()
  || requiredAddress(
    network.deployment?.contracts?.synthFeeGaugeFactory,
    "network fee factory",
  ).toLowerCase() !== addresses.feeFactory.toLowerCase()
) throw new Error("Network manifest does not match the staged synth topology");

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
  "function activateRiskOperations()",
]);
const assetAbi = parseAbi([
  "function owner() view returns (address)",
  "function vault() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const reserveAbi = parseAbi([
  "function authorizedVault(address) view returns (bool)",
  "function vaultsBound() view returns (bool)",
  "function vault0() view returns (address)",
  "function vault1() view returns (address)",
]);
const feeFactoryAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function guardian() view returns (address)",
  "function nusd() view returns (address)",
  "function dexFactory() view returns (address)",
  "function gaugeForPair(address) view returns (address)",
  "function mintFeePairForVault(address) view returns (address)",
  "function mintFeeVaultForPair(address) view returns (address)",
  "function setGaugeDepositsPaused(address,bool)",
]);
const gaugeAbi = parseAbi([
  "function stakingToken() view returns (address)",
  "function rewardToken() view returns (address)",
  "function distributor() view returns (address)",
  "function depositsPaused() view returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function totalFunded() view returns (uint256)",
  "function totalPaid() view returns (uint256)",
  "function rewardRate() view returns (uint256)",
  "function periodFinish() view returns (uint256)",
  "function lastUpdateTime() view returns (uint256)",
  "function rewardPerTokenStored() view returns (uint256)",
  "function pausedRewardDuration() view returns (uint256)",
]);
const pairAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function getReserves() view returns (uint112,uint112,uint32)",
]);
const oracleAbi = parseAbi(["function isFresh() view returns (bool)"]);
const lendingAbi = parseAbi([
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
  "function totalCollateralByAsset(address) view returns (uint256)",
  "function collateralConfigs(address) view returns (address,uint256,uint16,uint16,uint16,uint8,bool,uint16)",
]);
const marketActivatedEvent = parseAbiItem("event MarketActivated()");
const depositsPauseEvent = parseAbiItem("event DepositsPauseUpdated(bool paused)");

const read = (address, abi, functionName, args = []) => publicClient.readContract({
  address,
  abi,
  functionName,
  args,
});
const sameAddress = (left, right) => String(left).toLowerCase() === String(right).toLowerCase();

const [reserveState, factoryState, oracleFreshness] = await Promise.all([
  Promise.all([
    read(addresses.reserve, reserveAbi, "authorizedVault", [addresses.nBTCVault]),
    read(addresses.reserve, reserveAbi, "authorizedVault", [addresses.nETHVault]),
    read(addresses.reserve, reserveAbi, "vaultsBound"),
    read(addresses.reserve, reserveAbi, "vault0"),
    read(addresses.reserve, reserveAbi, "vault1"),
  ]),
  Promise.all([
    read(addresses.feeFactory, feeFactoryAbi, "owner"),
    read(addresses.feeFactory, feeFactoryAbi, "pendingOwner"),
    read(addresses.feeFactory, feeFactoryAbi, "guardian"),
    read(addresses.feeFactory, feeFactoryAbi, "nusd"),
    read(addresses.feeFactory, feeFactoryAbi, "dexFactory"),
    read(addresses.feeFactory, feeFactoryAbi, "gaugeForPair", [addresses.nBTCNusdPair]),
    read(addresses.feeFactory, feeFactoryAbi, "gaugeForPair", [addresses.nETHNusdPair]),
    read(addresses.feeFactory, feeFactoryAbi, "mintFeePairForVault", [addresses.nBTCVault]),
    read(addresses.feeFactory, feeFactoryAbi, "mintFeePairForVault", [addresses.nETHVault]),
    read(addresses.feeFactory, feeFactoryAbi, "mintFeeVaultForPair", [addresses.nBTCNusdPair]),
    read(addresses.feeFactory, feeFactoryAbi, "mintFeeVaultForPair", [addresses.nETHNusdPair]),
  ]),
  Promise.all([
    read(addresses.btcOracle, oracleAbi, "isFresh"),
    read(addresses.ethOracle, oracleAbi, "isFresh"),
  ]),
]);
if (!reserveState[0] || !reserveState[1] || !reserveState[2]
  || !sameAddress(reserveState[3], addresses.nBTCVault)
  || !sameAddress(reserveState[4], addresses.nETHVault)) {
  throw new Error("Synth safety-reserve vault bindings are incomplete");
}
for (const [actual, expected, label] of [
  [factoryState[0], owner, "fee factory owner"],
  [factoryState[1], zeroAddress, "fee factory pending owner"],
  [factoryState[2], owner, "fee factory guardian"],
  [factoryState[3], addresses.nusd, "fee factory NUSD"],
  [factoryState[4], addresses.factory, "fee factory DEX factory"],
  [factoryState[5], addresses.nBTCNusdGauge, "nBTC gauge route"],
  [factoryState[6], addresses.nETHNusdGauge, "nETH gauge route"],
  [factoryState[7], addresses.nBTCNusdPair, "nBTC vault fee route"],
  [factoryState[8], addresses.nETHNusdPair, "nETH vault fee route"],
  [factoryState[9], addresses.nBTCVault, "nBTC pair vault route"],
  [factoryState[10], addresses.nETHVault, "nETH pair vault route"],
]) if (!sameAddress(actual, expected)) throw new Error(`${label} mismatch`);
if (oracleFreshness.some((fresh) => !fresh)) throw new Error("A synth collateral oracle is stale");

const vaultDefinitions = [
  {
    id: "nbtc-vault",
    label: "nBTC vault",
    vault: addresses.nBTCVault,
    asset: addresses.nBTC,
    oracle: addresses.btcOracle,
    ceiling: BigInt(deployment.nBTCDebtCeiling),
  },
  {
    id: "neth-vault",
    label: "nETH vault",
    vault: addresses.nETHVault,
    asset: addresses.nETH,
    oracle: addresses.ethOracle,
    ceiling: BigInt(deployment.nETHDebtCeiling),
  },
];
const vaultStates = [];
for (const definition of vaultDefinitions) {
  const state = await Promise.all([
    read(definition.vault, vaultAbi, "owner"),
    read(definition.vault, vaultAbi, "pendingOwner"),
    read(definition.vault, vaultAbi, "guardian"),
    read(definition.vault, vaultAbi, "nusd"),
    read(definition.vault, vaultAbi, "syntheticAsset"),
    read(definition.vault, vaultAbi, "oracle"),
    read(definition.vault, vaultAbi, "safetyReserve"),
    read(definition.vault, vaultAbi, "mintFeeDistributor"),
    read(definition.vault, vaultAbi, "debtCeilingSynthetic"),
    read(definition.vault, vaultAbi, "totalCollateralNusd"),
    read(definition.vault, vaultAbi, "totalDebtSynthetic"),
    read(definition.vault, vaultAbi, "totalBadDebtSynthetic"),
    read(definition.vault, vaultAbi, "mintPaused"),
    read(definition.vault, vaultAbi, "withdrawPaused"),
    read(definition.vault, vaultAbi, "activated"),
    read(definition.asset, assetAbi, "owner"),
    read(definition.asset, assetAbi, "vault"),
    read(definition.asset, assetAbi, "totalSupply"),
  ]);
  for (const [actual, expected, label] of [
    [state[0], owner, "owner"],
    [state[1], zeroAddress, "pending owner"],
    [state[2], owner, "guardian"],
    [state[3], addresses.nusd, "NUSD"],
    [state[4], definition.asset, "asset"],
    [state[5], definition.oracle, "oracle"],
    [state[6], addresses.reserve, "reserve"],
    [state[7], addresses.feeFactory, "fee factory"],
    [state[15], zeroAddress, "asset owner"],
    [state[16], definition.vault, "asset vault"],
  ]) if (!sameAddress(actual, expected)) throw new Error(`${definition.label} ${label} mismatch`);
  if (state[8] !== definition.ceiling) throw new Error(`${definition.label} debt ceiling mismatch`);
  if (state[11] !== 0n) throw new Error(`${definition.label} has bad debt`);
  if (!state[14] && (state[9] !== 0n || state[10] !== 0n || state[17] !== 0n)) {
    throw new Error(`${definition.label} inactive accounting is not empty`);
  }
  if (state[14] ? (state[12] || state[13]) : (!state[12] || !state[13])) {
    throw new Error(`${definition.label} pause state does not match activation`);
  }
  vaultStates.push({ ...definition, activated: state[14] });
}

const gaugeDefinitions = [
  {
    id: "nbtc-gauge",
    label: "nBTC gauge",
    pair: addresses.nBTCNusdPair,
    gauge: addresses.nBTCNusdGauge,
  },
  {
    id: "neth-gauge",
    label: "nETH gauge",
    pair: addresses.nETHNusdPair,
    gauge: addresses.nETHNusdGauge,
  },
];
const gaugeStates = [];
for (const definition of gaugeDefinitions) {
  const state = await Promise.all([
    read(definition.gauge, gaugeAbi, "stakingToken"),
    read(definition.gauge, gaugeAbi, "rewardToken"),
    read(definition.gauge, gaugeAbi, "distributor"),
    read(definition.gauge, gaugeAbi, "depositsPaused"),
  ]);
  if (!sameAddress(state[0], definition.pair)
    || !sameAddress(state[1], addresses.nusd)
    || !sameAddress(state[2], addresses.feeFactory)) {
    throw new Error(`${definition.label} binding mismatch`);
  }
  gaugeStates.push({ ...definition, depositsPaused: state[3] });
}

const progress = [
  vaultStates[0].activated,
  vaultStates[1].activated,
  !gaugeStates[0].depositsPaused,
  !gaugeStates[1].depositsPaused,
];
const progressKey = progress.map((value) => value ? "1" : "0").join("");
if (!["0000", "1000", "1100", "1110", "1111"].includes(progressKey)) {
  throw new Error(`Synth activation is in an unsafe non-prefix state (${progressKey})`);
}
const allSynthActive = progressKey === "1111";

// Finalization and activation are deliberately separate. Recheck the empty
// pair/gauge accounting immediately before the first market is opened so a
// changed staged topology cannot cross the activation boundary unnoticed.
let initialMarketStateVerified = progressKey !== "0000";
if (progressKey === "0000") {
  for (const definition of [
    { label: "nBTC", asset: addresses.nBTC, pair: addresses.nBTCNusdPair, gauge: addresses.nBTCNusdGauge },
    { label: "nETH", asset: addresses.nETH, pair: addresses.nETHNusdPair, gauge: addresses.nETHNusdGauge },
  ]) {
    const [
      lpSupply,
      reserves,
      pairAssetBalance,
      pairNusdBalance,
      gaugeStake,
      gaugeFunded,
      gaugePaid,
      gaugeRewardRate,
      gaugePeriodFinish,
      gaugeLastUpdate,
      gaugeRewardAccumulator,
      gaugePausedDuration,
      gaugeLpBalance,
      gaugeNusdBalance,
    ] = await Promise.all([
      read(definition.pair, pairAbi, "totalSupply"),
      read(definition.pair, pairAbi, "getReserves"),
      read(definition.asset, assetAbi, "balanceOf", [definition.pair]),
      read(addresses.nusd, assetAbi, "balanceOf", [definition.pair]),
      read(definition.gauge, gaugeAbi, "totalSupply"),
      read(definition.gauge, gaugeAbi, "totalFunded"),
      read(definition.gauge, gaugeAbi, "totalPaid"),
      read(definition.gauge, gaugeAbi, "rewardRate"),
      read(definition.gauge, gaugeAbi, "periodFinish"),
      read(definition.gauge, gaugeAbi, "lastUpdateTime"),
      read(definition.gauge, gaugeAbi, "rewardPerTokenStored"),
      read(definition.gauge, gaugeAbi, "pausedRewardDuration"),
      read(definition.pair, assetAbi, "balanceOf", [definition.gauge]),
      read(addresses.nusd, assetAbi, "balanceOf", [definition.gauge]),
    ]);
    if (
      lpSupply !== 0n || reserves[0] !== 0n || reserves[1] !== 0n
        || pairAssetBalance !== 0n || pairNusdBalance !== 0n
        || gaugeStake !== 0n || gaugeFunded !== 0n || gaugePaid !== 0n
        || gaugeRewardRate !== 0n || gaugePeriodFinish !== 0n || gaugeLastUpdate !== 0n
        || gaugeRewardAccumulator !== 0n || gaugePausedDuration !== 0n
        || gaugeLpBalance !== 0n || gaugeNusdBalance !== 0n
    ) throw new Error(`${definition.label} pair/gauge changed after staged finalization`);
  }
  initialMarketStateVerified = true;
}

const lendingState = await Promise.all([
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
]);
if (String(lendingState[0]).toLowerCase() !== CURRENT_LENDING_IMPLEMENTATION_ID) {
  throw new Error("Synth activation requires the reviewed fixed-rate lending implementation");
}
const lendingSafety = synthActivationLendingSafety({
  allSynthActive,
  activated: lendingState[1],
  bootstrapOpen: lendingState[2],
  supplyPaused: lendingState[3],
  borrowPaused: lendingState[4],
  collateralWithdrawalPaused: lendingState[5],
  totalBorrowed: lendingState[6],
  totalBadDebt: lendingState[7],
  collateralAssetCount: lendingState[8],
});
const lendingStaged = lendingSafety.staged;
const lendingActive = lendingSafety.active;
if (!lendingSafety.runtimeModeSafe) {
  throw new Error("Lending must remain safely staged until synth activation completes");
}
if (!lendingSafety.collateralCountSafe) {
  throw new Error("Lending collateral count is not synth-activation safe");
}
if (!lendingSafety.debtSafe || !lendingSafety.badDebtSafe) {
  throw new Error("Lending debt or bad debt is not synth-activation safe");
}
for (const [index, expected] of [
  [9, addresses.wzkLTC],
  [10, addresses.oldNBTC],
  [11, addresses.oldNETH],
  [12, addresses.nBTC],
  [13, addresses.nETH],
]) if (!sameAddress(lendingState[index], expected)) throw new Error("Lending collateral order mismatch");

const collateralDefinitions = [
  [addresses.wzkLTC, addresses.ltcOracle, deployment.wzkLtcCollateralCap, true],
  [addresses.oldNBTC, addresses.btcOracle, deployment.nBTCLendingCollateralCap, false],
  [addresses.oldNETH, addresses.ethOracle, deployment.nETHLendingCollateralCap, false],
  [addresses.nBTC, addresses.btcOracle, deployment.nBTCLendingCollateralCap, true],
  [addresses.nETH, addresses.ethOracle, deployment.nETHLendingCollateralCap, true],
];
for (const [asset, oracle, cap, enabled] of collateralDefinitions) {
  const [config, deposited] = await Promise.all([
    read(addresses.lending, lendingAbi, "collateralConfigs", [asset]),
    read(addresses.lending, lendingAbi, "totalCollateralByAsset", [asset]),
  ]);
  if (
    !lendingCollateralConfigurationMatches(config, { oracle, cap, enabled })
      || (lendingSafety.requiresEmptyAccounting && deposited !== 0n)
  ) {
    throw new Error(`Lending collateral ${asset} is not synth-activation safe`);
  }
}

const actions = [
  ...vaultStates.map((state) => ({
    id: state.id,
    complete: state.activated,
    callTarget: state.vault,
    eventTarget: state.vault,
    abi: vaultAbi,
    functionName: "activateRiskOperations",
    args: [],
    event: marketActivatedEvent,
  })),
  ...gaugeStates.map((state) => ({
    id: state.id,
    complete: !state.depositsPaused,
    callTarget: addresses.feeFactory,
    eventTarget: state.gauge,
    abi: feeFactoryAbi,
    functionName: "setGaugeDepositsPaused",
    args: [state.pair, false],
    event: depositsPauseEvent,
  })),
];

for (const action of actions.filter((item) => !item.complete)) {
  await publicClient.simulateContract({
    account: account || owner,
    address: action.callTarget,
    abi: action.abi,
    functionName: action.functionName,
    args: action.args,
  });
}

const publicationReady = deployment.synthRiskActivationStatus === "active"
  && deployment.synthRiskActionsEnabled === true
  && network.deployment?.synthRiskActivationStatus === "active"
  && network.deployment?.synthRiskActionsEnabled === true;
if (!broadcast) {
  console.log(JSON.stringify({
    mode: "check",
    chainId,
    progress: progressKey,
    allSynthActive,
    publicationReady,
    initialMarketStateVerified,
    readyToResume: !allSynthActive,
    publicationRepairRequired: allSynthActive && !publicationReady,
    lending: { staged: lendingStaged, active: lendingActive },
    actions: actions.map(({ id, complete }) => ({ id, complete })),
  }, null, 2));
  if (allSynthActive && !publicationReady) process.exitCode = 1;
  process.exit();
}

const sent = new Map();
for (const action of actions) {
  if (action.complete) continue;
  const result = await sendContract(
    runtime,
    action.callTarget,
    action.abi,
    action.functionName,
    action.args,
  );
  sent.set(action.id, result);
  action.complete = true;
}

const recordedActions = new Map(
  (deployment.synthRiskActivation?.actions || []).map((action) => [action.id, action]),
);
const fromBlock = BigInt(migration.block || deployment.deploymentBlock);
const actionRecords = [];
for (const action of actions) {
  const logs = await publicClient.getLogs({
    address: action.eventTarget,
    event: action.event,
    fromBlock,
    toBlock: "latest",
  });
  const matchingLogs = action.functionName === "setGaugeDepositsPaused"
    ? logs.filter((log) => log.args?.paused === false)
    : logs;
  const sentResult = sent.get(action.id);
  const recordedHash = recordedActions.get(action.id)?.transactionHash;
  const evidence = sentResult
    ? matchingLogs.find((log) => log.transactionHash?.toLowerCase() === sentResult.hash.toLowerCase())
    : matchingLogs.find((log) => (
      recordedHash && log.transactionHash?.toLowerCase() === recordedHash.toLowerCase()
    )) || matchingLogs.at(-1);
  if (!evidence?.transactionHash) throw new Error(`${action.id} has no receipt-backed event evidence`);
  const receipt = sentResult?.receipt
    || await publicClient.getTransactionReceipt({ hash: evidence.transactionHash });
  if (receipt.status !== "success" || !sameAddress(receipt.to, action.callTarget)) {
    throw new Error(`${action.id} activation receipt is invalid`);
  }
  actionRecords.push({
    id: action.id,
    target: action.eventTarget,
    block: receipt.blockNumber.toString(),
    transactionHash: evidence.transactionHash,
  });
}

const postVaultActive = await Promise.all(vaultDefinitions.map((item) => (
  read(item.vault, vaultAbi, "activated")
)));
const postGaugePaused = await Promise.all(gaugeDefinitions.map((item) => (
  read(item.gauge, gaugeAbi, "depositsPaused")
)));
if (postVaultActive.some((value) => !value) || postGaugePaused.some((value) => value)) {
  throw new Error("Synth activation post-state verification failed");
}

const lastBlockNumber = actionRecords.reduce(
  (latest, action) => BigInt(action.block) > latest ? BigInt(action.block) : latest,
  0n,
);
const lastBlock = await publicClient.getBlock({ blockNumber: lastBlockNumber });
const activatedAt = new Date(Number(lastBlock.timestamp) * 1000).toISOString();
const activationRecord = { activatedAt, actions: actionRecords };
const activationHashes = actionRecords.map((action) => action.transactionHash);

deployment.synthRiskActivation = activationRecord;
deployment.synthRiskActivationStatus = "active";
deployment.synthRiskActionsEnabled = true;
deployment.synthSafetyReserveMigration = {
  ...migration,
  activationRequired: false,
  activationCompleted: true,
  activatedAt,
  activationTransactions: actionRecords,
};
deployment.transactionHashes = [...new Set([
  ...(deployment.transactionHashes || []),
  ...activationHashes,
])];
network.deployment = {
  ...network.deployment,
  synthSafetyReserveMigration: deployment.synthSafetyReserveMigration,
  synthRiskActivation: activationRecord,
  synthRiskActivationStatus: "active",
  synthRiskActionsEnabled: true,
};

saveRuntime(network, deployment);
writePublicEnvironment({
  root,
  deployment,
  network,
  rpcUrl: primaryRpcUrl(network),
});

console.log(JSON.stringify({
  mode: progressKey === "1111" ? "publication-repair" : "broadcast",
  chainId,
  progressBefore: progressKey,
  activatedAt,
  riskActionsEnabled: true,
  transactionsSent: sent.size,
  actions: actionRecords,
}, null, 2));
