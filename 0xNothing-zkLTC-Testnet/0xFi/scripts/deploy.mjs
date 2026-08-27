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
import { privateKeyToAccount } from "viem/accounts";

import { atomicWriteFile } from "./lib/graduation-runtime.mjs";
import {
  creationInputMatchesArtifact,
  CURRENT_LENDING_COLLATERAL_RISK,
  CURRENT_LENDING_IMPLEMENTATION_STATUS,
} from "./lib/lending-implementation.mjs";
import { resolvePrivateKey } from "./lib/private-key.mjs";
import { publicEnvironmentValues, writePublicEnvironment } from "./lib/public-environment.mjs";
import { fallbackRpcUrl, primaryRpcUrl, RPC_BATCH_OPTIONS } from "./lib/rpc.mjs";
import { runStep } from "./lib/spawn-step.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });

const allowedFlags = new Set(["--dry-run", "--broadcast", "--resume", "--finalize-only"]);
const requestedFlags = process.argv.slice(2).filter((argument) => argument.startsWith("--"));
if (requestedFlags.some((flag) => !allowedFlags.has(flag)) || requestedFlags.length !== 1) {
  throw new Error("Choose exactly one of --dry-run, --broadcast, --resume, or --finalize-only");
}
const mode = requestedFlags[0];
const broadcast = mode === "--broadcast";
const resume = mode === "--resume";
const finalizeOnly = mode === "--finalize-only";
const dryRun = mode === "--dry-run";

const networkPath = path.join(root, "config", "liteforge-testnet.json");
const latestPath = path.join(root, "contracts", "deployments", "latest.json");
const predictionPath = path.join(root, "contracts", "deployments", "fresh-deployment.json");
const broadcastPath = path.join(
  root,
  "contracts",
  "broadcast",
  "Deploy0xFi.s.sol",
  String(JSON.parse(fs.readFileSync(networkPath, "utf8")).chainId),
  "run-latest.json",
);
const network = JSON.parse(fs.readFileSync(networkPath, "utf8"));
const previousLatest = fs.existsSync(latestPath) ? JSON.parse(fs.readFileSync(latestPath, "utf8")) : undefined;
const finalizedDeploymentExists = Boolean(previousLatest?.broadcasted && previousLatest?.deploymentBlock);
if ((broadcast || resume) && finalizedDeploymentExists) {
  throw new Error("A finalized deployment already exists; refusing to create or resume another suite");
}
if (broadcast && fs.existsSync(broadcastPath)) {
  throw new Error("A previous live broadcast journal exists. Use deploy:resume or deploy:finalize.");
}
if (resume && !fs.existsSync(broadcastPath)) throw new Error("No live broadcast journal exists to resume");

const { privateKey } = resolvePrivateKey();
const account = privateKeyToAccount(privateKey);
const rpcUrl = primaryRpcUrl(network);
const client = createPublicClient({
  transport: fallback([
    http(rpcUrl, { ...RPC_BATCH_OPTIONS, timeout: 15_000, retryCount: 2 }),
    http(fallbackRpcUrl(network), { ...RPC_BATCH_OPTIONS, timeout: 15_000, retryCount: 1 }),
  ]),
});

const run = (command, args, extraEnv = {}, cwd = root) => runStep(command, args, extraEnv, cwd);

function requireAddress(value, label) {
  if (!isAddress(value)) throw new Error(`Invalid ${label} address in deployment output`);
  return getAddress(value);
}

function sameAddress(left, right) {
  return isAddress(left) && isAddress(right) && left.toLowerCase() === right.toLowerCase();
}

function expectAddress(actual, expected, label) {
  if (!sameAddress(actual, expected)) throw new Error(`${label} binding mismatch`);
}

const addressKeys = [
  "ltcOracle",
  "btcOracle",
  "ethOracle",
  "wzkLTC",
  "dexFactory",
  "dexRouter",
  "pumpGraduationAdapter",
  "gaugeFactory",
  "synthSafetyReserve",
  "nBTC",
  "nETH",
  "nBTCVault",
  "nETHVault",
  "lendingPool",
  "wzkLtcNusdPair",
  "nBTCNusdPair",
  "nETHNusdPair",
  "wzkLtcNusdGauge",
  "nBTCNusdGauge",
  "nETHNusdGauge",
];

async function finalizeDeployment(prediction) {
  if (!fs.existsSync(broadcastPath)) throw new Error("Foundry broadcast receipt file is missing");
  const broadcastData = JSON.parse(fs.readFileSync(broadcastPath, "utf8"));
  const transactions = broadcastData.transactions || [];
  const deployer = requireAddress(prediction.deployer, "deployer");
  if (deployer.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`Prediction deployer ${deployer} differs from configured wallet ${account.address}`);
  }
  if (!transactions.length || transactions.some((transaction) => !/^0x[0-9a-fA-F]{64}$/.test(transaction.hash || ""))) {
    throw new Error("Broadcast journal contains a missing or invalid transaction hash");
  }
  const hashes = [...new Set(transactions.map((transaction) => transaction.hash.toLowerCase()))];
  if (hashes.length !== transactions.length) throw new Error("Broadcast journal contains duplicate transaction hashes");

  const lendingCreates = transactions.filter((transaction) => (
    transaction.transactionType === "CREATE" && transaction.contractName === "PooledNUSDLendingPool"
  ));
  if (lendingCreates.length !== 1) {
    throw new Error("Broadcast journal must contain exactly one lending-pool creation");
  }
  const lendingArtifactPath = path.join(
    root,
    "contracts",
    "out",
    "PooledNUSDLendingPool.sol",
    "PooledNUSDLendingPool.json",
  );
  if (!fs.existsSync(lendingArtifactPath)) throw new Error("Current lending artifact is missing; run the contract build");
  const lendingArtifact = JSON.parse(fs.readFileSync(lendingArtifactPath, "utf8"));
  if (!creationInputMatchesArtifact(lendingCreates[0].transaction?.input, lendingArtifact.bytecode?.object)) {
    throw new Error("Broadcast lending creation bytecode does not match the current audited artifact");
  }
  const reserveCreates = transactions.filter((transaction) => (
    transaction.transactionType === "CREATE" && transaction.contractName === "SynthSafetyReserve"
  ));
  if (reserveCreates.length !== 1) {
    throw new Error("Broadcast journal must contain exactly one synth-safety-reserve creation");
  }
  const reserveArtifactPath = path.join(
    root,
    "contracts",
    "out",
    "SynthSafetyReserve.sol",
    "SynthSafetyReserve.json",
  );
  if (!fs.existsSync(reserveArtifactPath)) throw new Error("Current synth reserve artifact is missing; run the contract build");
  const reserveArtifact = JSON.parse(fs.readFileSync(reserveArtifactPath, "utf8"));
  if (!creationInputMatchesArtifact(reserveCreates[0].transaction?.input, reserveArtifact.bytecode?.object)) {
    throw new Error("Broadcast synth reserve creation bytecode does not match the current audited artifact");
  }
  const receipts = [];
  for (const hash of hashes) {
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`Deployment transaction reverted: ${hash}`);
    receipts.push(receipt);
  }
  const receiptByHash = new Map(receipts.map((receipt) => [
    receipt.transactionHash.toLowerCase(),
    receipt,
  ]));
  for (const transaction of transactions) {
    const receipt = receiptByHash.get(transaction.hash.toLowerCase());
    if (!receipt) throw new Error(`Missing receipt evidence for ${transaction.hash}`);
    expectAddress(receipt.from, deployer, `receipt sender for ${transaction.hash}`);
    if (transaction.transactionType === "CREATE") {
      if (!receipt.contractAddress) {
        throw new Error(`CREATE receipt has no contract address: ${transaction.hash}`);
      }
      expectAddress(
        receipt.contractAddress,
        transaction.contractAddress,
        `CREATE receipt address for ${transaction.hash}`,
      );
    } else if (transaction.transaction?.to) {
      if (!receipt.to) throw new Error(`Call receipt has no target: ${transaction.hash}`);
      expectAddress(receipt.to, transaction.transaction.to, `receipt target for ${transaction.hash}`);
    }
  }
  const deploymentBlock = receipts.reduce(
    (minimum, receipt) => receipt.blockNumber < minimum ? receipt.blockNumber : minimum,
    receipts[0].blockNumber,
  );

  const normalized = Object.fromEntries(addressKeys.map((key) => [key, requireAddress(prediction[key], key)]));
  for (const [key, address] of Object.entries(normalized)) {
    const code = await client.getCode({ address });
    if (!code || code === "0x") throw new Error(`No deployed bytecode at ${key}: ${address}`);
  }
  const nusd = requireAddress(prediction.nusd, "NUSD");
  const pump = requireAddress(prediction.pump, "Pump");
  const pumpRouter = requireAddress(prediction.pumpGraduationRouter, "Pump graduation router");
  expectAddress(lendingCreates[0].contractAddress, normalized.lendingPool, "broadcast lending creation");
  expectAddress(reserveCreates[0].contractAddress, normalized.synthSafetyReserve, "broadcast synth reserve creation");
  expectAddress(nusd, network.existingContracts.nusd, "NUSD");
  expectAddress(pump, network.existingContracts.pump, "Pump");
  expectAddress(pumpRouter, network.existingContracts.pumpGraduationRouter, "Pump router");

  const ownableAbi = parseAbi([
    "function owner() view returns (address)",
    "function pendingOwner() view returns (address)",
    "function guardian() view returns (address)",
  ]);
  const factoryAbi = parseAbi([
    "function nusd() view returns (address)",
    "function pump() view returns (address)",
    "function graduationAdapter() view returns (address)",
    "function getPair(address,address) view returns (address)",
  ]);
  const dexRouterAbi = parseAbi([
    "function factory() view returns (address)",
    "function wzkLTC() view returns (address)",
  ]);
  const gaugeFactoryAbi = parseAbi([
    "function nusd() view returns (address)",
    "function dexFactory() view returns (address)",
    "function gaugeForPair(address) view returns (address)",
  ]);
  const synthAbi = parseAbi(["function owner() view returns (address)", "function vault() view returns (address)"]);
  const vaultAbi = parseAbi([
    "function nusd() view returns (address)",
    "function syntheticAsset() view returns (address)",
    "function oracle() view returns (address)",
    "function safetyReserve() view returns (address)",
    "function debtCeilingSynthetic() view returns (uint256)",
  ]);
  const reserveAbi = parseAbi([
    "function nusd() view returns (address)",
    "function ENTRY_TVL_NUSD() view returns (uint256)",
    "function EXIT_TVL_NUSD() view returns (uint256)",
    "function ACTIVATION_DELAY() view returns (uint256)",
    "function vaultsBound() view returns (bool)",
    "function vault0() view returns (address)",
    "function vault1() view returns (address)",
    "function authorizedVault(address) view returns (bool)",
    "function sponsorshipActive() view returns (bool)",
    "function allocationsPaused() view returns (bool)",
    "function totalReserveNusd() view returns (uint256)",
    "function totalAllocatedNusd() view returns (uint256)",
  ]);
  const oracleAbi = parseAbi(["function feed() view returns (address)", "function isFresh() view returns (bool)"]);
  const lendingAbi = parseAbi([
    "function supplyCapNusd() view returns (uint256)",
    "function borrowCapNusd() view returns (uint256)",
    "function collateralConfigs(address) view returns (address,uint256,uint16,uint16,uint16,uint8,bool,uint16)",
  ]);
  const pumpRouterAbi = parseAbi([
    "function admin() view returns (address)",
    "function minimumDelay() view returns (uint256)",
    "function enabled() view returns (bool)",
    "function enableAt() view returns (uint256)",
    "function isAdapterAllowed(address) view returns (bool)",
    "function adapterActivationTime(address) view returns (uint256)",
  ]);

  const governed = [
    normalized.dexFactory,
    normalized.gaugeFactory,
    normalized.synthSafetyReserve,
    normalized.nBTCVault,
    normalized.nETHVault,
    normalized.lendingPool,
  ];
  const [
    factoryNusd,
    factoryPump,
    factoryAdapter,
    dexRouterFactory,
    dexRouterWzkLTC,
    gaugeNusd,
    gaugeDexFactory,
    owners,
    pendingOwners,
    guardians,
    nBTCOwner,
    nETHOwner,
    nBTCBoundVault,
    nETHBoundVault,
    pairBindings,
    gaugeBindings,
    oracleBindings,
    oracleFreshness,
    vaultBindings,
    debtCeilings,
    supplyCap,
    borrowCap,
    collateral,
    routerAdmin,
    routerDelay,
    routerEnabled,
    enableAt,
    adapterAllowed,
    adapterAt,
    currentBlock,
  ] = await Promise.all([
    client.readContract({ address: normalized.dexFactory, abi: factoryAbi, functionName: "nusd" }),
    client.readContract({ address: normalized.dexFactory, abi: factoryAbi, functionName: "pump" }),
    client.readContract({ address: normalized.dexFactory, abi: factoryAbi, functionName: "graduationAdapter" }),
    client.readContract({ address: normalized.dexRouter, abi: dexRouterAbi, functionName: "factory" }),
    client.readContract({ address: normalized.dexRouter, abi: dexRouterAbi, functionName: "wzkLTC" }),
    client.readContract({ address: normalized.gaugeFactory, abi: gaugeFactoryAbi, functionName: "nusd" }),
    client.readContract({ address: normalized.gaugeFactory, abi: gaugeFactoryAbi, functionName: "dexFactory" }),
    Promise.all(governed.map((address) => client.readContract({ address, abi: ownableAbi, functionName: "owner" }))),
    Promise.all(governed.map((address) => client.readContract({ address, abi: ownableAbi, functionName: "pendingOwner" }))),
    Promise.all(governed.map((address) => client.readContract({ address, abi: ownableAbi, functionName: "guardian" }))),
    client.readContract({ address: normalized.nBTC, abi: synthAbi, functionName: "owner" }),
    client.readContract({ address: normalized.nETH, abi: synthAbi, functionName: "owner" }),
    client.readContract({ address: normalized.nBTC, abi: synthAbi, functionName: "vault" }),
    client.readContract({ address: normalized.nETH, abi: synthAbi, functionName: "vault" }),
    Promise.all([
      [normalized.wzkLTC, normalized.wzkLtcNusdPair],
      [normalized.nBTC, normalized.nBTCNusdPair],
      [normalized.nETH, normalized.nETHNusdPair],
    ].map(([asset]) => client.readContract({
      address: normalized.dexFactory,
      abi: factoryAbi,
      functionName: "getPair",
      args: [asset, nusd],
    }))),
    Promise.all([
      normalized.wzkLtcNusdPair,
      normalized.nBTCNusdPair,
      normalized.nETHNusdPair,
    ].map((pair) => client.readContract({
      address: normalized.gaugeFactory,
      abi: gaugeFactoryAbi,
      functionName: "gaugeForPair",
      args: [pair],
    }))),
    Promise.all([normalized.ltcOracle, normalized.btcOracle, normalized.ethOracle].map((oracle) => (
      client.readContract({ address: oracle, abi: oracleAbi, functionName: "feed" })
    ))),
    Promise.all([normalized.ltcOracle, normalized.btcOracle, normalized.ethOracle].map((oracle) => (
      client.readContract({ address: oracle, abi: oracleAbi, functionName: "isFresh" })
    ))),
    Promise.all([
      [normalized.nBTCVault, normalized.nBTC, normalized.btcOracle],
      [normalized.nETHVault, normalized.nETH, normalized.ethOracle],
    ].map(async ([vault, asset, oracle]) => Promise.all([
      client.readContract({ address: vault, abi: vaultAbi, functionName: "nusd" }),
      client.readContract({ address: vault, abi: vaultAbi, functionName: "syntheticAsset" }),
      client.readContract({ address: vault, abi: vaultAbi, functionName: "oracle" }),
      client.readContract({ address: vault, abi: vaultAbi, functionName: "safetyReserve" }),
    ]).then(([boundNusd, boundAsset, boundOracle, boundReserve]) => (
      sameAddress(boundNusd, nusd) && sameAddress(boundAsset, asset) && sameAddress(boundOracle, oracle)
        && sameAddress(boundReserve, normalized.synthSafetyReserve)
    )))),
    Promise.all([normalized.nBTCVault, normalized.nETHVault].map((vault) => (
      client.readContract({ address: vault, abi: vaultAbi, functionName: "debtCeilingSynthetic" })
    ))),
    client.readContract({ address: normalized.lendingPool, abi: lendingAbi, functionName: "supplyCapNusd" }),
    client.readContract({ address: normalized.lendingPool, abi: lendingAbi, functionName: "borrowCapNusd" }),
    Promise.all([
      [normalized.wzkLTC, normalized.ltcOracle],
      [normalized.nBTC, normalized.btcOracle],
      [normalized.nETH, normalized.ethOracle],
    ].map(([asset]) => client.readContract({
      address: normalized.lendingPool,
      abi: lendingAbi,
      functionName: "collateralConfigs",
      args: [asset],
    }))),
    client.readContract({ address: pumpRouter, abi: pumpRouterAbi, functionName: "admin" }),
    client.readContract({ address: pumpRouter, abi: pumpRouterAbi, functionName: "minimumDelay" }),
    client.readContract({ address: pumpRouter, abi: pumpRouterAbi, functionName: "enabled" }),
    client.readContract({ address: pumpRouter, abi: pumpRouterAbi, functionName: "enableAt" }),
    client.readContract({ address: pumpRouter, abi: pumpRouterAbi, functionName: "isAdapterAllowed", args: [normalized.pumpGraduationAdapter] }),
    client.readContract({ address: pumpRouter, abi: pumpRouterAbi, functionName: "adapterActivationTime", args: [normalized.pumpGraduationAdapter] }),
    client.getBlock(),
  ]);

  expectAddress(factoryNusd, nusd, "factory NUSD");
  expectAddress(factoryPump, pump, "factory Pump");
  expectAddress(factoryAdapter, normalized.pumpGraduationAdapter, "factory adapter");
  expectAddress(dexRouterFactory, normalized.dexFactory, "DEX router factory");
  expectAddress(dexRouterWzkLTC, normalized.wzkLTC, "DEX router WzkLTC");
  expectAddress(gaugeNusd, nusd, "gauge factory NUSD");
  expectAddress(gaugeDexFactory, normalized.dexFactory, "gauge factory DEX");
  if (owners.some((owner) => !sameAddress(owner, deployer))) throw new Error("Direct-governance owner mismatch");
  if (pendingOwners.some((owner) => owner.toLowerCase() !== zeroAddress)) throw new Error("Unexpected pending owner");
  if (guardians.some((value) => !sameAddress(value, deployer))) throw new Error("Guardian mismatch");
  if (nBTCOwner.toLowerCase() !== zeroAddress || nETHOwner.toLowerCase() !== zeroAddress) {
    throw new Error("Synthetic asset ownership was not renounced");
  }
  expectAddress(nBTCBoundVault, normalized.nBTCVault, "nBTC vault");
  expectAddress(nETHBoundVault, normalized.nETHVault, "nETH vault");
  [normalized.wzkLtcNusdPair, normalized.nBTCNusdPair, normalized.nETHNusdPair]
    .forEach((expected, index) => expectAddress(pairBindings[index], expected, `pair ${index + 1}`));
  [normalized.wzkLtcNusdGauge, normalized.nBTCNusdGauge, normalized.nETHNusdGauge]
    .forEach((expected, index) => expectAddress(gaugeBindings[index], expected, `gauge ${index + 1}`));
  [network.dia.feeds.wzkLTC, network.dia.feeds.nBTC, network.dia.feeds.nETH]
    .forEach((expected, index) => expectAddress(oracleBindings[index], expected, `oracle feed ${index + 1}`));
  if (oracleFreshness.some((fresh) => !fresh)) throw new Error("One or more DIA feeds are stale");
  if (vaultBindings.some((binding) => !binding)) throw new Error("Synthetic vault binding mismatch");
  const reserveState = await Promise.all([
    client.readContract({ address: normalized.synthSafetyReserve, abi: reserveAbi, functionName: "nusd" }),
    client.readContract({ address: normalized.synthSafetyReserve, abi: reserveAbi, functionName: "ENTRY_TVL_NUSD" }),
    client.readContract({ address: normalized.synthSafetyReserve, abi: reserveAbi, functionName: "EXIT_TVL_NUSD" }),
    client.readContract({ address: normalized.synthSafetyReserve, abi: reserveAbi, functionName: "ACTIVATION_DELAY" }),
    client.readContract({ address: normalized.synthSafetyReserve, abi: reserveAbi, functionName: "vaultsBound" }),
    client.readContract({ address: normalized.synthSafetyReserve, abi: reserveAbi, functionName: "vault0" }),
    client.readContract({ address: normalized.synthSafetyReserve, abi: reserveAbi, functionName: "vault1" }),
    client.readContract({ address: normalized.synthSafetyReserve, abi: reserveAbi, functionName: "authorizedVault", args: [normalized.nBTCVault] }),
    client.readContract({ address: normalized.synthSafetyReserve, abi: reserveAbi, functionName: "authorizedVault", args: [normalized.nETHVault] }),
    client.readContract({ address: normalized.synthSafetyReserve, abi: reserveAbi, functionName: "sponsorshipActive" }),
    client.readContract({ address: normalized.synthSafetyReserve, abi: reserveAbi, functionName: "allocationsPaused" }),
    client.readContract({ address: normalized.synthSafetyReserve, abi: reserveAbi, functionName: "totalReserveNusd" }),
    client.readContract({ address: normalized.synthSafetyReserve, abi: reserveAbi, functionName: "totalAllocatedNusd" }),
  ]);
  expectAddress(reserveState[0], nusd, "synth reserve NUSD");
  if (reserveState[1] !== 100_000n * 10n ** 18n || reserveState[2] !== 90_000n * 10n ** 18n
    || reserveState[3] !== 86_400n) throw new Error("Synth reserve threshold configuration mismatch");
  if (!reserveState[4]) throw new Error("Synth reserve vault binding is not finalized");
  expectAddress(reserveState[5], normalized.nBTCVault, "synth reserve vault0");
  expectAddress(reserveState[6], normalized.nETHVault, "synth reserve vault1");
  if (!reserveState[7] || !reserveState[8]) throw new Error("Synth reserve vault authorization mismatch");
  if (reserveState[9] || reserveState[10] || reserveState[11] !== 0n || reserveState[12] !== 0n) {
    throw new Error("Fresh synth reserve must be empty, unpaused, and in protected mode");
  }
  if (debtCeilings[0] !== BigInt(prediction.nBTCDebtCeiling)
    || debtCeilings[1] !== BigInt(prediction.nETHDebtCeiling)) throw new Error("Debt ceiling mismatch");
  if (supplyCap !== BigInt(prediction.lendingSupplyCapNusd)
    || borrowCap !== BigInt(prediction.lendingBorrowCapNusd)) throw new Error("Lending cap mismatch");
  const expectedCollateral = [
    [normalized.ltcOracle, BigInt(prediction.wzkLtcCollateralCap)],
    [normalized.btcOracle, BigInt(prediction.nBTCLendingCollateralCap)],
    [normalized.ethOracle, BigInt(prediction.nETHLendingCollateralCap)],
  ];
  collateral.forEach((config, index) => {
    const [oracle, cap] = expectedCollateral[index];
    if (!sameAddress(config[0], oracle)
      || config[1] !== cap
      || config[2] !== CURRENT_LENDING_COLLATERAL_RISK.loanToValueBps
      || config[3] !== CURRENT_LENDING_COLLATERAL_RISK.liquidationThresholdBps
      || config[4] !== CURRENT_LENDING_COLLATERAL_RISK.liquidationBonusBps
      || config[5] !== CURRENT_LENDING_COLLATERAL_RISK.decimals
      || !config[6]
      || config[7] !== CURRENT_LENDING_COLLATERAL_RISK.marginCallThresholdBps) {
      throw new Error(`Collateral configuration ${index + 1} mismatch`);
    }
  });
  expectAddress(routerAdmin, deployer, "Pump router admin");
  const expectedDelay = BigInt(network.pumpGraduation?.minimumDelaySeconds ?? 172_800);
  if (routerDelay !== expectedDelay) throw new Error("Pump router delay mismatch");
  if (!adapterAllowed && (adapterAt === 0n || adapterAt <= currentBlock.timestamp)) {
    throw new Error("Graduation adapter is neither active nor safely scheduled");
  }
  if (!routerEnabled && (enableAt === 0n || enableAt <= currentBlock.timestamp)) {
    throw new Error("Pump router is neither enabled nor safely scheduled");
  }

  const sameSuite = previousLatest && sameAddress(previousLatest.dexFactory, normalized.dexFactory);
  if (finalizeOnly && finalizedDeploymentExists && !sameSuite) {
    throw new Error("Finalization journal does not belong to the recorded deployment");
  }
  const controllerMetadata = sameSuite && previousLatest.pumpGraduationController
    ? {
        pumpGraduationController: previousLatest.pumpGraduationController,
        pumpGraduationControllerDeploymentBlock: previousLatest.pumpGraduationControllerDeploymentBlock,
        pumpGraduationControllerDeploymentHash: previousLatest.pumpGraduationControllerDeploymentHash,
        graduationAutomationStatus: previousLatest.graduationAutomationStatus,
        graduationAutomationActivatedAt: previousLatest.graduationAutomationActivatedAt,
        graduationAutomationActivationHashes: previousLatest.graduationAutomationActivationHashes,
      }
    : {};
  const latest = {
    ...prediction,
    ...normalized,
    ...controllerMetadata,
    broadcasted: true,
    status: "deployed-direct-governance-pending-graduation-activation",
    governanceMode: "direct-deployer-no-timelock",
    governance: deployer,
    guardian: deployer,
    coreOwnershipStatus: "direct-deployer-owner-no-pending",
    riskMode: "caps-pauses-oracles-no-nusd-health-guard",
    lendingImplementationStatus: CURRENT_LENDING_IMPLEMENTATION_STATUS,
    lendingImplementationMigrationRequired: false,
    deploymentBlock: deploymentBlock.toString(),
    finalizedAt: new Date().toISOString(),
    deployer,
    nusd,
    pump,
    pumpGraduationRouter: pumpRouter,
    pumpAdapterActivationTime: adapterAt.toString(),
    pumpRouterEnableAt: enableAt.toString(),
    transactionHashes: [...new Set([...hashes, ...(sameSuite ? previousLatest.transactionHashes || [] : [])])],
  };
  const publicAddressKeys = [
    ...addressKeys,
    ...(latest.pumpGraduationController ? ["pumpGraduationController"] : []),
  ];
  network.deployment = {
    status: latest.status,
    governanceMode: latest.governanceMode,
    governance: latest.governance,
    guardian: latest.guardian,
    coreOwnershipStatus: latest.coreOwnershipStatus,
    riskMode: latest.riskMode,
    lendingImplementationStatus: latest.lendingImplementationStatus,
    lendingImplementationMigrationRequired: latest.lendingImplementationMigrationRequired,
    deploymentBlock: latest.deploymentBlock,
    finalizedAt: latest.finalizedAt,
    contracts: Object.fromEntries(publicAddressKeys.map((key) => [key, latest[key]])),
    pumpAdapterActivationTime: latest.pumpAdapterActivationTime,
    pumpRouterEnableAt: latest.pumpRouterEnableAt,
    ...(latest.graduationAutomationStatus ? { graduationAutomationStatus: latest.graduationAutomationStatus } : {}),
  };
  const subgraphConfigPath = path.join(root, "subgraph", "subgraph.config.json");
  const subgraphConfig = JSON.parse(fs.readFileSync(subgraphConfigPath, "utf8"));
  Object.assign(subgraphConfig, {
    factoryAddress: latest.dexFactory,
    gaugeFactoryAddress: latest.gaugeFactory,
    nbtcVaultAddress: latest.nBTCVault,
    nethVaultAddress: latest.nETHVault,
    lendingPoolAddress: latest.lendingPool,
    nusdAddress: latest.nusd,
    startBlock: Number(deploymentBlock),
  });
  publicEnvironmentValues({ deployment: latest, network, rpcUrl });
  atomicWriteFile(latestPath, `${JSON.stringify(latest, null, 2)}\n`);
  atomicWriteFile(networkPath, `${JSON.stringify(network, null, 2)}\n`);
  atomicWriteFile(subgraphConfigPath, `${JSON.stringify(subgraphConfig, null, 2)}\n`);
  writePublicEnvironment({ root, deployment: latest, network, rpcUrl });

  console.log(JSON.stringify({
    status: latest.status,
    governanceMode: latest.governanceMode,
    deploymentBlock: latest.deploymentBlock,
    deployer,
    transactionCount: hashes.length,
    contracts: Object.fromEntries(addressKeys.map((key) => [key, latest[key]])),
    pumpAdapterActivationTime: latest.pumpAdapterActivationTime,
    pumpRouterEnableAt: latest.pumpRouterEnableAt,
  }, null, 2));
}

await run(process.execPath, [path.join(root, "scripts", "preflight.mjs")]);

if (!finalizeOnly) {
  const forgeArgs = [
    "script",
    "script/Deploy0xFi.s.sol:Deploy0xFi",
    "--rpc-url",
    rpcUrl,
  ];
  if (!resume) forgeArgs.push("--force");
  if (broadcast) forgeArgs.push("--broadcast", "--slow");
  if (resume) forgeArgs.push("--resume", "--broadcast", "--slow");
  await run("forge", forgeArgs, { PRIVATE_KEY: privateKey }, path.join(root, "contracts"));
}

if (!fs.existsSync(predictionPath)) throw new Error("Direct-governance prediction manifest is missing");
const prediction = JSON.parse(fs.readFileSync(predictionPath, "utf8"));
if (Number(prediction.chainId) !== Number(network.chainId)) throw new Error("Prediction manifest has the wrong chain ID");
if (!sameAddress(prediction.deployer, account.address)) throw new Error("Prediction manifest has the wrong deployer");

if (broadcast || resume || finalizeOnly) {
  await finalizeDeployment(prediction);
} else if (dryRun) {
  console.log(JSON.stringify({
    mode: "dry-run",
    chainId: prediction.chainId,
    deployer: account.address,
    governanceMode: "direct-deployer-no-timelock",
    predicted: Object.fromEntries(addressKeys.map((key) => [key, prediction[key]])),
    pumpAdapterActivationTime: prediction.pumpAdapterActivationTime,
    pumpRouterEnableAt: prediction.pumpRouterEnableAt,
    broadcasted: false,
  }, null, 2));
}
