import process from "node:process";

import { parseAbi, zeroAddress } from "viem";

import {
  governanceAddress,
  governanceMode,
  loadRuntime,
  requiredAddress,
} from "./lib/graduation-runtime.mjs";
import {
  lendingActivationState,
  lendingCollateralConfigurationMatches,
  lendingImplementationState,
  lendingRuntimeState,
} from "./lib/lending-implementation.mjs";
import { synthRiskActionsManifestEnabled } from "./lib/public-environment.mjs";

const allowInactive = process.argv.includes("--allow-inactive");
if (process.argv.some((argument) => argument.startsWith("--") && argument !== "--allow-inactive")) {
  throw new Error("Usage: npm run audit:live or npm run audit:live:report");
}

const { deployment, network, publicClient } = loadRuntime();
const chainId = await publicClient.getChainId();
if (chainId !== Number(network.chainId) || chainId !== Number(deployment.chainId)) {
  throw new Error(`Wrong chain: expected ${network.chainId}, received ${chainId}`);
}
const mode = governanceMode(deployment);
const governance = governanceAddress(deployment);
const guardian = requiredAddress(deployment.guardian || deployment.deployer, "guardian");
const addressOf = (value, label) => requiredAddress(value, label);
const sameAddress = (left, right) => (
  typeof left === "string"
  && typeof right === "string"
  && left.toLowerCase() === right.toLowerCase()
);
const synthSafetyReserveExpected = Boolean(
  deployment.synthSafetyReserve
  || deployment.synthSafetyReserveMigration
  || deployment.synthSafetyReserveStatus,
);
const synthMigration = deployment.synthSafetyReserveMigration;
const synthSafetyReserveAddress = deployment.synthSafetyReserve
  ? addressOf(deployment.synthSafetyReserve, "synth safety reserve")
  : undefined;
const synthFeeGaugeFactoryAddress = deployment.synthFeeGaugeFactory
  ? addressOf(deployment.synthFeeGaugeFactory, "synth fee gauge factory")
  : undefined;
const addresses = {
  nusd: addressOf(deployment.nusd, "NUSD"),
  pump: addressOf(deployment.pump, "Pump"),
  pumpRouter: addressOf(deployment.pumpGraduationRouter, "Pump router"),
  controller: addressOf(deployment.pumpGraduationController, "graduation controller"),
  adapter: addressOf(deployment.pumpGraduationAdapter, "graduation adapter"),
  factory: addressOf(deployment.dexFactory, "DEX factory"),
  dexRouter: addressOf(deployment.dexRouter, "DEX router"),
  gaugeFactory: addressOf(deployment.gaugeFactory, "gauge factory"),
  ...(synthFeeGaugeFactoryAddress ? { synthFeeGaugeFactory: synthFeeGaugeFactoryAddress } : {}),
  ...(synthSafetyReserveAddress ? { synthSafetyReserve: synthSafetyReserveAddress } : {}),
  lending: addressOf(deployment.lendingPool, "lending pool"),
  wzkLTC: addressOf(deployment.wzkLTC, "WzkLTC"),
  nBTC: addressOf(deployment.nBTC, "nBTC"),
  nETH: addressOf(deployment.nETH, "nETH"),
  nBTCVault: addressOf(deployment.nBTCVault, "nBTC vault"),
  nETHVault: addressOf(deployment.nETHVault, "nETH vault"),
  ltcOracle: addressOf(deployment.ltcOracle, "LTC oracle"),
  btcOracle: addressOf(deployment.btcOracle, "BTC oracle"),
  ethOracle: addressOf(deployment.ethOracle, "ETH oracle"),
  wzkLtcNusdPair: addressOf(deployment.wzkLtcNusdPair, "WzkLTC/NUSD pair"),
  nBTCNusdPair: addressOf(deployment.nBTCNusdPair, "nBTC/NUSD pair"),
  nETHNusdPair: addressOf(deployment.nETHNusdPair, "nETH/NUSD pair"),
  wzkLtcNusdGauge: addressOf(deployment.wzkLtcNusdGauge, "WzkLTC/NUSD gauge"),
  nBTCNusdGauge: addressOf(deployment.nBTCNusdGauge, "nBTC/NUSD gauge"),
  nETHNusdGauge: addressOf(deployment.nETHNusdGauge, "nETH/NUSD gauge"),
};

// Issue every bytecode probe in one pass so the batching transport collapses
// them into a single request instead of one round trip per address.
const addressEntries = Object.entries(addresses);
const addressCodes = await Promise.all(
  addressEntries.map(([, address]) => publicClient.getCode({ address })),
);
const deployed = Object.fromEntries(addressEntries.map(([name], index) => (
  [name, Boolean(addressCodes[index] && addressCodes[index] !== "0x")]
)));
if (mode === "timelock") {
  const code = await publicClient.getCode({ address: governance });
  deployed.governance = Boolean(code && code !== "0x");
}
const missingCode = Object.entries(deployed).filter(([, present]) => !present).map(([name]) => name);
if (missingCode.length) throw new Error(`Missing bytecode: ${missingCode.join(", ")}`);

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
const pumpRouterAbi = parseAbi([
  "function admin() view returns (address)",
  "function pendingAdmin() view returns (address)",
  "function enabled() view returns (bool)",
  "function isAdapterAllowed(address) view returns (bool)",
  "function enableAt() view returns (uint256)",
  "function adapterActivationTime(address) view returns (uint256)",
]);
const pumpAbi = parseAbi([
  "function admin() view returns (address)",
  "function pendingAdmin() view returns (address)",
]);
const controllerAbi = parseAbi([
  "function pump() view returns (address)",
  "function adapter() view returns (address)",
  "function router() view returns (address)",
  "function governance() view returns (address)",
  "function guardian() view returns (address)",
  "function graduationsPaused() view returns (bool)",
]);
const oracleAbi = parseAbi([
  "function feed() view returns (address)",
  "function isFresh() view returns (bool)",
]);
const lendingAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function guardian() view returns (address)",
  "function supplyCapNusd() view returns (uint256)",
  "function borrowCapNusd() view returns (uint256)",
  "function supplyPaused() view returns (bool)",
  "function borrowPaused() view returns (bool)",
  "function collateralWithdrawalPaused() view returns (bool)",
  "function activated() view returns (bool)",
  "function bootstrapOpen() view returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function totalBorrowed() view returns (uint256)",
  "function totalBadDebtNusd() view returns (uint256)",
  "function totalCollateralByAsset(address) view returns (uint256)",
  "function collateralAssetCount() view returns (uint256)",
  "function collateralAssetAt(uint256) view returns (address)",
]);
const lendingIdentityAbi = parseAbi([
  "function IMPLEMENTATION_ID() view returns (bytes32)",
]);
const currentLendingCollateralAbi = parseAbi([
  "function collateralConfigs(address) view returns (address,uint256,uint16,uint16,uint16,uint8,bool,uint16)",
]);
const legacyLendingCollateralAbi = parseAbi([
  "function collateralConfigs(address) view returns (address,uint256,uint16,uint16,uint16,uint8,bool)",
]);
const liveLendingImplementationId = await publicClient.readContract({
  address: addresses.lending,
  abi: lendingIdentityAbi,
  functionName: "IMPLEMENTATION_ID",
}).catch(() => null);
const recordedLendingImplementation = lendingImplementationState(deployment);
const lendingImplementation = lendingRuntimeState(deployment, liveLendingImplementationId);
const lendingCollateralAbi = lendingImplementation.runtimeCompatible
  ? currentLendingCollateralAbi
  : legacyLendingCollateralAbi;
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const gaugeFactoryAbi = parseAbi([
  "function nusd() view returns (address)",
  "function dexFactory() view returns (address)",
  "function gaugeForPair(address) view returns (address)",
  "function mintFeePairForVault(address) view returns (address)",
  "function mintFeeVaultForPair(address) view returns (address)",
]);
const gaugeAbi = parseAbi(["function depositsPaused() view returns (bool)"]);
const synthAbi = parseAbi([
  "function owner() view returns (address)",
  "function vault() view returns (address)",
  "function totalSupply() view returns (uint256)",
]);
const vaultAbi = parseAbi([
  "function nusd() view returns (address)",
  "function syntheticAsset() view returns (address)",
  "function oracle() view returns (address)",
  "function safetyReserve() view returns (address)",
  "function mintFeeDistributor() view returns (address)",
  "function debtCeilingSynthetic() view returns (uint256)",
  "function totalCollateralNusd() view returns (uint256)",
  "function totalUserCollateralNusd() view returns (uint256)",
  "function totalReserveCollateralNusd() view returns (uint256)",
  "function totalDebtSynthetic() view returns (uint256)",
  "function totalBadDebtSynthetic() view returns (uint256)",
  "function mintPaused() view returns (bool)",
  "function withdrawPaused() view returns (bool)",
  "function activated() view returns (bool)",
]);
const synthSafetyReserveAbi = parseAbi([
  "function nusd() view returns (address)",
  "function vault0() view returns (address)",
  "function vault1() view returns (address)",
  "function vaultsBound() view returns (bool)",
  "function authorizedVault(address) view returns (bool)",
  "function ENTRY_TVL_NUSD() view returns (uint256)",
  "function EXIT_TVL_NUSD() view returns (uint256)",
  "function ACTIVATION_DELAY() view returns (uint256)",
  "function totalReserveNusd() view returns (uint256)",
  "function freeReserveNusd() view returns (uint256)",
  "function totalAllocatedNusd() view returns (uint256)",
  "function allocatedNusdByVault(address) view returns (uint256)",
  "function sponsorshipActive() view returns (bool)",
  "function eligibleSince() view returns (uint256)",
  "function allocationsPaused() view returns (bool)",
  "function nusdBackingHealthy() view returns (bool)",
]);
const pairAbi = parseAbi(["function totalSupply() view returns (uint256)"]);

const coreTargets = [...new Set([
  addresses.factory,
  addresses.gaugeFactory,
  ...(synthFeeGaugeFactoryAddress ? [synthFeeGaugeFactoryAddress] : []),
  ...(synthSafetyReserveAddress ? [synthSafetyReserveAddress] : []),
  addresses.nBTCVault,
  addresses.nETHVault,
  addresses.lending,
])];
const [
  factoryNusd,
  factoryPump,
  factoryAdapter,
  routerFactory,
  routerWzkLTC,
  pumpAdmin,
  pumpPendingAdmin,
  pumpRouterAdmin,
  pumpRouterPendingAdmin,
  routerEnabled,
  adapterAllowed,
  routerEnableAt,
  adapterAt,
  controllerPump,
  controllerAdapter,
  controllerRouter,
  controllerGovernance,
  controllerGuardian,
  graduationsPaused,
  coreOwners,
  corePendingOwners,
  coreGuardians,
  lendingPauses,
  lendingActivationRuntime,
  lendingCaps,
  lendingAccounting,
  gaugeFactoryNusd,
  gaugeFactoryDex,
] = await Promise.all([
  publicClient.readContract({ address: addresses.factory, abi: factoryAbi, functionName: "nusd" }),
  publicClient.readContract({ address: addresses.factory, abi: factoryAbi, functionName: "pump" }),
  publicClient.readContract({ address: addresses.factory, abi: factoryAbi, functionName: "graduationAdapter" }),
  publicClient.readContract({ address: addresses.dexRouter, abi: dexRouterAbi, functionName: "factory" }),
  publicClient.readContract({ address: addresses.dexRouter, abi: dexRouterAbi, functionName: "wzkLTC" }),
  publicClient.readContract({ address: addresses.pump, abi: pumpAbi, functionName: "admin" }),
  publicClient.readContract({ address: addresses.pump, abi: pumpAbi, functionName: "pendingAdmin" }),
  publicClient.readContract({ address: addresses.pumpRouter, abi: pumpRouterAbi, functionName: "admin" }),
  publicClient.readContract({ address: addresses.pumpRouter, abi: pumpRouterAbi, functionName: "pendingAdmin" }),
  publicClient.readContract({ address: addresses.pumpRouter, abi: pumpRouterAbi, functionName: "enabled" }),
  publicClient.readContract({ address: addresses.pumpRouter, abi: pumpRouterAbi, functionName: "isAdapterAllowed", args: [addresses.adapter] }),
  publicClient.readContract({ address: addresses.pumpRouter, abi: pumpRouterAbi, functionName: "enableAt" }),
  publicClient.readContract({ address: addresses.pumpRouter, abi: pumpRouterAbi, functionName: "adapterActivationTime", args: [addresses.adapter] }),
  publicClient.readContract({ address: addresses.controller, abi: controllerAbi, functionName: "pump" }),
  publicClient.readContract({ address: addresses.controller, abi: controllerAbi, functionName: "adapter" }),
  publicClient.readContract({ address: addresses.controller, abi: controllerAbi, functionName: "router" }),
  publicClient.readContract({ address: addresses.controller, abi: controllerAbi, functionName: "governance" }),
  publicClient.readContract({ address: addresses.controller, abi: controllerAbi, functionName: "guardian" }),
  publicClient.readContract({ address: addresses.controller, abi: controllerAbi, functionName: "graduationsPaused" }),
  Promise.all(coreTargets.map((address) => publicClient.readContract({ address, abi: ownableAbi, functionName: "owner" }))),
  Promise.all(coreTargets.map((address) => publicClient.readContract({ address, abi: ownableAbi, functionName: "pendingOwner" }))),
  Promise.all(coreTargets.map((address) => publicClient.readContract({ address, abi: ownableAbi, functionName: "guardian" }))),
  Promise.all(["supplyPaused", "borrowPaused", "collateralWithdrawalPaused"].map((functionName) => (
    publicClient.readContract({ address: addresses.lending, abi: lendingAbi, functionName })
  ))),
  Promise.all(["activated", "bootstrapOpen"].map((functionName) => (
    publicClient.readContract({ address: addresses.lending, abi: lendingAbi, functionName }).catch(() => null)
  ))),
  Promise.all(["supplyCapNusd", "borrowCapNusd"].map((functionName) => (
    publicClient.readContract({ address: addresses.lending, abi: lendingAbi, functionName })
  ))),
  Promise.all([
    publicClient.readContract({ address: addresses.lending, abi: lendingAbi, functionName: "totalSupply" }),
    publicClient.readContract({ address: addresses.lending, abi: lendingAbi, functionName: "totalBorrowed" }),
    publicClient.readContract({ address: addresses.lending, abi: lendingAbi, functionName: "totalBadDebtNusd" }),
    publicClient.readContract({
      address: addresses.nusd,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [addresses.lending],
    }),
  ]),
  publicClient.readContract({ address: addresses.gaugeFactory, abi: gaugeFactoryAbi, functionName: "nusd" }),
  publicClient.readContract({ address: addresses.gaugeFactory, abi: gaugeFactoryAbi, functionName: "dexFactory" }),
]);

const synthFeeFactoryState = synthFeeGaugeFactoryAddress
  ? await Promise.all([
      publicClient.readContract({ address: synthFeeGaugeFactoryAddress, abi: gaugeFactoryAbi, functionName: "nusd" }),
      publicClient.readContract({ address: synthFeeGaugeFactoryAddress, abi: gaugeFactoryAbi, functionName: "dexFactory" }),
      publicClient.readContract({ address: synthFeeGaugeFactoryAddress, abi: gaugeFactoryAbi, functionName: "mintFeePairForVault", args: [addresses.nBTCVault] }),
      publicClient.readContract({ address: synthFeeGaugeFactoryAddress, abi: gaugeFactoryAbi, functionName: "mintFeePairForVault", args: [addresses.nETHVault] }),
      publicClient.readContract({ address: synthFeeGaugeFactoryAddress, abi: gaugeFactoryAbi, functionName: "mintFeeVaultForPair", args: [addresses.nBTCNusdPair] }),
      publicClient.readContract({ address: synthFeeGaugeFactoryAddress, abi: gaugeFactoryAbi, functionName: "mintFeeVaultForPair", args: [addresses.nETHNusdPair] }),
    ])
  : undefined;

const collateralDefinitions = synthMigration
  ? [
    ["wzkLTC", "wzkLTC", addresses.wzkLTC, addresses.ltcOracle, deployment.wzkLtcCollateralCap, true],
    ["retired nBTC", "nBTC", addressOf(synthMigration.previousNBTC, "retired nBTC"), addresses.btcOracle, deployment.nBTCLendingCollateralCap || deployment.nBTCDebtCeiling, false],
    ["retired nETH", "nETH", addressOf(synthMigration.previousNETH, "retired nETH"), addresses.ethOracle, deployment.nETHLendingCollateralCap || deployment.nETHDebtCeiling, false],
    ["nBTC", "nBTC", addresses.nBTC, addresses.btcOracle, deployment.nBTCLendingCollateralCap || deployment.nBTCDebtCeiling, true],
    ["nETH", "nETH", addresses.nETH, addresses.ethOracle, deployment.nETHLendingCollateralCap || deployment.nETHDebtCeiling, true],
  ]
  : [
    ["wzkLTC", "wzkLTC", addresses.wzkLTC, addresses.ltcOracle, deployment.wzkLtcCollateralCap, true],
    ["nBTC", "nBTC", addresses.nBTC, addresses.btcOracle, deployment.nBTCLendingCollateralCap || deployment.nBTCDebtCeiling, true],
    ["nETH", "nETH", addresses.nETH, addresses.ethOracle, deployment.nETHLendingCollateralCap || deployment.nETHDebtCeiling, true],
  ];
// Every collateral probe is an independent view read, so fan them out together
// and keep the definition order through the resolved array.
const collateral = await Promise.all(collateralDefinitions.map(async (
  [symbol, feedKey, asset, oracle, cap, enabled],
) => {
  const [config, feed, fresh] = await Promise.all([
    publicClient.readContract({ address: addresses.lending, abi: lendingCollateralAbi, functionName: "collateralConfigs", args: [asset] }),
    publicClient.readContract({ address: oracle, abi: oracleAbi, functionName: "feed" }),
    publicClient.readContract({ address: oracle, abi: oracleAbi, functionName: "isFresh" }),
  ]);
  const expectedFeed = addressOf(network.dia.feeds[feedKey], `${symbol} DIA feed`);
  const configured = lendingImplementation.runtimeCompatible
    && lendingCollateralConfigurationMatches(config, { oracle, cap, enabled })
    && feed.toLowerCase() === expectedFeed.toLowerCase();
  return {
    symbol,
    oracle,
    feed,
    configured,
    enabled: config[6],
    supplyCap: config[1].toString(),
    loanToValueBps: config[2],
    marginCallThresholdBps: lendingImplementation.runtimeCompatible ? config[7] : null,
    liquidationThresholdBps: config[3],
    liquidationBonusBps: config[4],
    decimals: config[5],
    oracleFresh: fresh,
  };
}));
const [collateralAssetCount, collateralAssetOrder] = await Promise.all([
  publicClient.readContract({
    address: addresses.lending,
    abi: lendingAbi,
    functionName: "collateralAssetCount",
  }),
  Promise.all(collateralDefinitions.map((_, index) => (
    publicClient.readContract({
      address: addresses.lending,
      abi: lendingAbi,
      functionName: "collateralAssetAt",
      args: [BigInt(index)],
    })
  ))),
]);
const lendingCollateralTopologyReady = collateralAssetCount === BigInt(collateralDefinitions.length)
  && collateralDefinitions.every((definition, index) => (
    sameAddress(collateralAssetOrder[index], definition[2])
  ));

const expectedPairs = [
  ["wzkLTC", addresses.wzkLTC, addresses.wzkLtcNusdPair, addresses.wzkLtcNusdGauge, addresses.gaugeFactory],
  ["nBTC", addresses.nBTC, addresses.nBTCNusdPair, addresses.nBTCNusdGauge, synthFeeGaugeFactoryAddress || addresses.gaugeFactory],
  ["nETH", addresses.nETH, addresses.nETHNusdPair, addresses.nETHNusdGauge, synthFeeGaugeFactoryAddress || addresses.gaugeFactory],
];
const pools = await Promise.all(expectedPairs.map(async (
  [symbol, asset, expectedPair, expectedGauge, gaugeFactory],
) => {
  const [pair, gauge, lpSupply, depositsPaused] = await Promise.all([
    publicClient.readContract({ address: addresses.factory, abi: factoryAbi, functionName: "getPair", args: [asset, addresses.nusd] }),
    publicClient.readContract({ address: gaugeFactory, abi: gaugeFactoryAbi, functionName: "gaugeForPair", args: [expectedPair] }),
    publicClient.readContract({ address: expectedPair, abi: pairAbi, functionName: "totalSupply" }),
    publicClient.readContract({ address: expectedGauge, abi: gaugeAbi, functionName: "depositsPaused" }),
  ]);
  return {
    asset: symbol,
    pair,
    gauge,
    gaugeFactory,
    bindingOk: pair.toLowerCase() === expectedPair.toLowerCase() && gauge.toLowerCase() === expectedGauge.toLowerCase(),
    hasLiquidity: lpSupply > 0n,
    lpSupply: lpSupply.toString(),
    depositsPaused,
  };
}));

const vaultDefinitions = [
  ["nBTC", addresses.nBTC, addresses.nBTCVault, addresses.btcOracle, deployment.nBTCDebtCeiling],
  ["nETH", addresses.nETH, addresses.nETHVault, addresses.ethOracle, deployment.nETHDebtCeiling],
];
const vaults = await Promise.all(vaultDefinitions.map(async (
  [symbol, asset, vault, oracle, debtCeiling],
) => {
  const [assetOwner, boundVault, synthSupply, vaultNusd, vaultAsset, vaultOracle, ceiling, mintFeeDistributor] = await Promise.all([
    publicClient.readContract({ address: asset, abi: synthAbi, functionName: "owner" }),
    publicClient.readContract({ address: asset, abi: synthAbi, functionName: "vault" }),
    publicClient.readContract({ address: asset, abi: synthAbi, functionName: "totalSupply" }),
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "nusd" }),
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "syntheticAsset" }),
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "oracle" }),
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "debtCeilingSynthetic" }),
    ...(synthFeeGaugeFactoryAddress
      ? [publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "mintFeeDistributor" })]
      : [Promise.resolve(undefined)]),
  ]);
  let reserveAccounting = null;
  if (synthSafetyReserveAddress) {
    const [
      vaultReserve,
      totalCollateral,
      userCollateral,
      reserveCollateral,
      totalDebt,
      totalBadDebt,
      mintPaused,
      withdrawPaused,
      activated,
      nusdBalance,
    ] = await Promise.all([
      publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "safetyReserve" }),
      publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalCollateralNusd" }),
      publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalUserCollateralNusd" }),
      publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalReserveCollateralNusd" }),
      publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalDebtSynthetic" }),
      publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalBadDebtSynthetic" }),
      publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "mintPaused" }),
      publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "withdrawPaused" }),
      publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "activated" }),
      publicClient.readContract({ address: addresses.nusd, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
    ]);
    reserveAccounting = {
      safetyReserve: vaultReserve,
      totalCollateralNusd: totalCollateral,
      totalUserCollateralNusd: userCollateral,
      totalReserveCollateralNusd: reserveCollateral,
      totalDebtSynthetic: totalDebt,
      totalBadDebtSynthetic: totalBadDebt,
      syntheticSupply: synthSupply,
      nusdBalance,
      surplusNusd: nusdBalance - totalCollateral,
      mintPaused,
      withdrawPaused,
      activated,
      accountingOk: totalCollateral === userCollateral + reserveCollateral
        && nusdBalance >= totalCollateral
        && synthSupply === totalDebt + totalBadDebt,
    };
  }
  return {
    symbol,
    bindingOk: assetOwner.toLowerCase() === zeroAddress
      && boundVault.toLowerCase() === vault.toLowerCase()
      && vaultNusd.toLowerCase() === addresses.nusd.toLowerCase()
      && vaultAsset.toLowerCase() === asset.toLowerCase()
      && vaultOracle.toLowerCase() === oracle.toLowerCase()
      && ceiling === BigInt(debtCeiling)
      && (!synthFeeGaugeFactoryAddress
        || mintFeeDistributor?.toLowerCase() === synthFeeGaugeFactoryAddress.toLowerCase())
      && (!synthSafetyReserveExpected || Boolean(
        reserveAccounting
        && reserveAccounting.safetyReserve.toLowerCase() === synthSafetyReserveAddress?.toLowerCase()
        && reserveAccounting.accountingOk
      )),
    debtCeiling: ceiling.toString(),
    mintFeeDistributor: mintFeeDistributor || null,
    syntheticSupply: synthSupply,
    reserveAccounting,
  };
}));

let synthSafetyReserve = {
  expected: synthSafetyReserveExpected,
  configured: Boolean(synthSafetyReserveAddress),
  address: synthSafetyReserveAddress || null,
  ready: !synthSafetyReserveExpected,
};
if (synthSafetyReserveAddress) {
  const [
    reserveNusd,
    vault0,
    vault1,
    vaultsBound,
    nbtcAuthorized,
    nethAuthorized,
    entryTvlNusd,
    exitTvlNusd,
    activationDelay,
    totalReserveNusd,
    freeReserveNusd,
    totalAllocatedNusd,
    nbtcAllocatedNusd,
    nethAllocatedNusd,
    sponsorshipActive,
    eligibleSince,
    allocationsPaused,
    nusdBackingHealthy,
    nusdBalance,
  ] = await Promise.all([
    publicClient.readContract({ address: synthSafetyReserveAddress, abi: synthSafetyReserveAbi, functionName: "nusd" }),
    publicClient.readContract({ address: synthSafetyReserveAddress, abi: synthSafetyReserveAbi, functionName: "vault0" }),
    publicClient.readContract({ address: synthSafetyReserveAddress, abi: synthSafetyReserveAbi, functionName: "vault1" }),
    publicClient.readContract({ address: synthSafetyReserveAddress, abi: synthSafetyReserveAbi, functionName: "vaultsBound" }),
    publicClient.readContract({ address: synthSafetyReserveAddress, abi: synthSafetyReserveAbi, functionName: "authorizedVault", args: [addresses.nBTCVault] }),
    publicClient.readContract({ address: synthSafetyReserveAddress, abi: synthSafetyReserveAbi, functionName: "authorizedVault", args: [addresses.nETHVault] }),
    publicClient.readContract({ address: synthSafetyReserveAddress, abi: synthSafetyReserveAbi, functionName: "ENTRY_TVL_NUSD" }),
    publicClient.readContract({ address: synthSafetyReserveAddress, abi: synthSafetyReserveAbi, functionName: "EXIT_TVL_NUSD" }),
    publicClient.readContract({ address: synthSafetyReserveAddress, abi: synthSafetyReserveAbi, functionName: "ACTIVATION_DELAY" }),
    publicClient.readContract({ address: synthSafetyReserveAddress, abi: synthSafetyReserveAbi, functionName: "totalReserveNusd" }),
    publicClient.readContract({ address: synthSafetyReserveAddress, abi: synthSafetyReserveAbi, functionName: "freeReserveNusd" }),
    publicClient.readContract({ address: synthSafetyReserveAddress, abi: synthSafetyReserveAbi, functionName: "totalAllocatedNusd" }),
    publicClient.readContract({ address: synthSafetyReserveAddress, abi: synthSafetyReserveAbi, functionName: "allocatedNusdByVault", args: [addresses.nBTCVault] }),
    publicClient.readContract({ address: synthSafetyReserveAddress, abi: synthSafetyReserveAbi, functionName: "allocatedNusdByVault", args: [addresses.nETHVault] }),
    publicClient.readContract({ address: synthSafetyReserveAddress, abi: synthSafetyReserveAbi, functionName: "sponsorshipActive" }),
    publicClient.readContract({ address: synthSafetyReserveAddress, abi: synthSafetyReserveAbi, functionName: "eligibleSince" }),
    publicClient.readContract({ address: synthSafetyReserveAddress, abi: synthSafetyReserveAbi, functionName: "allocationsPaused" }),
    publicClient.readContract({ address: synthSafetyReserveAddress, abi: synthSafetyReserveAbi, functionName: "nusdBackingHealthy" }),
    publicClient.readContract({ address: addresses.nusd, abi: erc20Abi, functionName: "balanceOf", args: [synthSafetyReserveAddress] }),
  ]);
  const nbtcVaultReserve = vaults[0].reserveAccounting?.totalReserveCollateralNusd ?? -1n;
  const nethVaultReserve = vaults[1].reserveAccounting?.totalReserveCollateralNusd ?? -1n;
  const bindingsOk = reserveNusd.toLowerCase() === addresses.nusd.toLowerCase()
    && vaultsBound
    && nbtcAuthorized
    && nethAuthorized
    && vault0.toLowerCase() === addresses.nBTCVault.toLowerCase()
    && vault1.toLowerCase() === addresses.nETHVault.toLowerCase();
  const thresholdsOk = entryTvlNusd === 100_000n * 10n ** 18n
    && exitTvlNusd === 90_000n * 10n ** 18n
    && activationDelay === 86_400n;
  const accountingOk = totalReserveNusd === freeReserveNusd + totalAllocatedNusd
    && freeReserveNusd === nusdBalance
    && totalAllocatedNusd === nbtcAllocatedNusd + nethAllocatedNusd
    && nbtcAllocatedNusd === nbtcVaultReserve
    && nethAllocatedNusd === nethVaultReserve;
  const modeSafe = !sponsorshipActive
    || (nusdBackingHealthy && totalReserveNusd >= exitTvlNusd);
  const eligibilitySafe = eligibleSince === 0n
    || (nusdBackingHealthy && totalReserveNusd >= entryTvlNusd);
  synthSafetyReserve = {
    expected: true,
    configured: true,
    address: synthSafetyReserveAddress,
    entryTvlNusd,
    exitTvlNusd,
    activationDelay,
    totalReserveNusd,
    freeReserveNusd,
    totalAllocatedNusd,
    allocatedNusdByVault: {
      nBTC: nbtcAllocatedNusd,
      nETH: nethAllocatedNusd,
    },
    sponsorshipActive,
    eligibleSince,
    allocationsPaused,
    nusdBackingHealthy,
    bindingsOk,
    thresholdsOk,
    accountingOk,
    modeSafe,
    eligibilitySafe,
    ready: bindingsOk && thresholdsOk && accountingOk && modeSafe && eligibilitySafe,
  };
}

const reserveMigration = synthMigration;
const retiredDefinitions = reserveMigration
  ? [
    ["nBTC", reserveMigration.previousNBTC, reserveMigration.previousNBTCVault],
    ["nETH", reserveMigration.previousNETH, reserveMigration.previousNETHVault],
  ]
  : [];
const retiredSynthMarkets = await Promise.all(retiredDefinitions.map(async ([symbol, rawAsset, rawVault]) => {
  const asset = addressOf(rawAsset, `previous ${symbol}`);
  const vault = addressOf(rawVault, `previous ${symbol} vault`);
  const [config, lendingCollateral, totalSupply, collateral, debt, badDebt, mintPaused, withdrawPaused, rawNusdBalance] = await Promise.all([
    publicClient.readContract({ address: addresses.lending, abi: lendingCollateralAbi, functionName: "collateralConfigs", args: [asset] }),
    publicClient.readContract({ address: addresses.lending, abi: lendingAbi, functionName: "totalCollateralByAsset", args: [asset] }),
    publicClient.readContract({ address: asset, abi: erc20Abi, functionName: "totalSupply" }),
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalCollateralNusd" }),
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalDebtSynthetic" }),
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalBadDebtSynthetic" }),
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "mintPaused" }),
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "withdrawPaused" }),
    publicClient.readContract({ address: addresses.nusd, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
  ]);
  const ready = !config[6]
    && lendingCollateral === 0n
    && totalSupply === 0n
    && debt === 0n
    && badDebt === 0n
    && mintPaused
    && !withdrawPaused
    && rawNusdBalance >= collateral;
  return {
    symbol,
    asset,
    vault,
    lendingEnabled: config[6],
    lendingCollateral,
    totalSupply,
    collateral,
    rawNusdBalance,
    surplusNusd: rawNusdBalance - collateral,
    debt,
    badDebt,
    mintPaused,
    withdrawPaused,
    ready,
  };
}));

const localContracts = network.deployment?.contracts || {};
const localBindings = {
  controller: "pumpGraduationController",
  adapter: "pumpGraduationAdapter",
  factory: "dexFactory",
  dexRouter: "dexRouter",
  gaugeFactory: "gaugeFactory",
  ...(synthFeeGaugeFactoryAddress ? { synthFeeGaugeFactory: "synthFeeGaugeFactory" } : {}),
  ...(synthSafetyReserveAddress ? { synthSafetyReserve: "synthSafetyReserve" } : {}),
  lending: "lendingPool",
  wzkLTC: "wzkLTC",
  nBTC: "nBTC",
  nETH: "nETH",
  nBTCVault: "nBTCVault",
  nETHVault: "nETHVault",
  ltcOracle: "ltcOracle",
  btcOracle: "btcOracle",
  ethOracle: "ethOracle",
  wzkLtcNusdPair: "wzkLtcNusdPair",
  nBTCNusdPair: "nBTCNusdPair",
  nETHNusdPair: "nETHNusdPair",
  wzkLtcNusdGauge: "wzkLtcNusdGauge",
  nBTCNusdGauge: "nBTCNusdGauge",
  nETHNusdGauge: "nETHNusdGauge",
};
const localManifestConsistent = Object.entries(localBindings).every(([addressKey, manifestKey]) => (
  sameAddress(localContracts[manifestKey], addresses[addressKey])
))
  && sameAddress(network.existingContracts?.nusd, addresses.nusd)
  && sameAddress(network.existingContracts?.pump, addresses.pump)
  && sameAddress(network.existingContracts?.pumpGraduationRouter, addresses.pumpRouter)
  && (!synthSafetyReserveExpected || (
    sameAddress(localContracts.synthSafetyReserve, synthSafetyReserveAddress)
    && network.deployment?.synthSafetyReserveStatus === deployment.synthSafetyReserveStatus
  ))
  && network.deployment?.lendingImplementationStatus === recordedLendingImplementation.status
  && Boolean(network.deployment?.lendingImplementationMigrationRequired)
    === recordedLendingImplementation.migrationRequired
  && network.deployment?.lendingFixedRateActivationStatus
    === deployment.lendingFixedRateActivationStatus
  && network.deployment?.lendingRiskActionsEnabled
    === deployment.lendingRiskActionsEnabled;
const synthManifestEnabled = synthRiskActionsManifestEnabled(deployment);
const synthManifestConsistent = !synthSafetyReserveExpected || (
  network.deployment?.synthRiskActivationStatus === deployment.synthRiskActivationStatus
    && network.deployment?.synthRiskActionsEnabled === deployment.synthRiskActionsEnabled
);
const synthRuntimeEnabled = !synthSafetyReserveExpected || (
  vaults.every((vault) => (
    vault.reserveAccounting?.activated === true
      && vault.reserveAccounting?.mintPaused === false
      && vault.reserveAccounting?.withdrawPaused === false
  ))
    && pools.filter((pool) => pool.asset !== "wzkLTC").every((pool) => !pool.depositsPaused)
);
const synthActivationReady = synthSafetyReserveExpected
  && synthManifestEnabled
  && synthManifestConsistent
  && synthRuntimeEnabled;
const lendingManifestMatchesRuntime = !recordedLendingImplementation.migrationRequired
  === lendingImplementation.runtimeCompatible;
const topologyOk = localManifestConsistent
  && lendingManifestMatchesRuntime
  && lendingImplementation.runtimeCompatible
  && factoryNusd.toLowerCase() === addresses.nusd.toLowerCase()
  && factoryPump.toLowerCase() === addresses.pump.toLowerCase()
  && factoryAdapter.toLowerCase() === addresses.adapter.toLowerCase()
  && routerFactory.toLowerCase() === addresses.factory.toLowerCase()
  && routerWzkLTC.toLowerCase() === addresses.wzkLTC.toLowerCase()
  && gaugeFactoryNusd.toLowerCase() === addresses.nusd.toLowerCase()
  && gaugeFactoryDex.toLowerCase() === addresses.factory.toLowerCase()
  && (!synthFeeFactoryState || (
    synthFeeFactoryState[0].toLowerCase() === addresses.nusd.toLowerCase()
    && synthFeeFactoryState[1].toLowerCase() === addresses.factory.toLowerCase()
    && synthFeeFactoryState[2].toLowerCase() === addresses.nBTCNusdPair.toLowerCase()
    && synthFeeFactoryState[3].toLowerCase() === addresses.nETHNusdPair.toLowerCase()
    && synthFeeFactoryState[4].toLowerCase() === addresses.nBTCVault.toLowerCase()
    && synthFeeFactoryState[5].toLowerCase() === addresses.nETHVault.toLowerCase()
  ))
  && controllerPump.toLowerCase() === addresses.pump.toLowerCase()
  && controllerAdapter.toLowerCase() === addresses.adapter.toLowerCase()
  && controllerRouter.toLowerCase() === addresses.pumpRouter.toLowerCase()
  && controllerGovernance.toLowerCase() === governance.toLowerCase()
  && controllerGuardian.toLowerCase() === guardian.toLowerCase()
  && lendingCollateralTopologyReady
  && collateral.every((item) => item.configured)
  && pools.every((item) => item.bindingOk)
  && vaults.every((item) => item.bindingOk)
  && synthSafetyReserve.ready
  && retiredSynthMarkets.every((item) => item.ready)
  && lendingCaps[0] === BigInt(deployment.lendingSupplyCapNusd)
  && lendingCaps[1] === BigInt(deployment.lendingBorrowCapNusd);
const coreOwnershipReady = coreOwners.every((owner) => owner.toLowerCase() === governance.toLowerCase())
  && corePendingOwners.every((pendingOwner) => pendingOwner.toLowerCase() === zeroAddress)
  && coreGuardians.every((currentGuardian) => currentGuardian.toLowerCase() === guardian.toLowerCase());
const graduationReady = coreOwnershipReady
  && routerEnabled
  && adapterAllowed
  && pumpAdmin.toLowerCase() === addresses.controller.toLowerCase()
  && pumpPendingAdmin.toLowerCase() === zeroAddress
  && pumpRouterAdmin.toLowerCase() === addresses.controller.toLowerCase()
  && pumpRouterPendingAdmin.toLowerCase() === zeroAddress
  && !graduationsPaused;
const oraclesFresh = collateral.every((item) => item.oracleFresh);
const lendingCollateralReady = collateral.every((item) => item.configured);
const lendingActivation = lendingActivationState(deployment, {
  activated: lendingActivationRuntime[0],
  bootstrapOpen: lendingActivationRuntime[1],
  supplyPaused: lendingPauses[0],
  borrowPaused: lendingPauses[1],
  collateralWithdrawalPaused: lendingPauses[2],
});
const operational = topologyOk
  && graduationReady
  && oraclesFresh
  && lendingImplementation.fixedRateImplementationReady
  && lendingActivation.ready
  && synthActivationReady;
const blockingIssues = [
  ...(!topologyOk ? ["topology-or-configuration-mismatch"] : []),
  ...(!graduationReady ? ["graduation-not-ready"] : []),
  ...(!oraclesFresh ? ["stale-collateral-oracle"] : []),
  ...(!lendingCollateralReady ? ["lending-collateral-configuration-mismatch"] : []),
  ...(!lendingCollateralTopologyReady ? ["lending-collateral-topology-mismatch"] : []),
  ...(!synthSafetyReserveExpected ? ["synth-safety-reserve-migration-required"] : []),
  ...(synthSafetyReserveExpected && !synthActivationReady ? ["synth-risk-activation-or-publication-required"] : []),
  ...(synthSafetyReserveExpected && !synthSafetyReserve.ready ? ["synth-safety-reserve-not-ready"] : []),
  ...(retiredSynthMarkets.some((item) => !item.ready) ? ["retired-synth-market-not-safe"] : []),
  ...(lendingImplementation.migrationRequired ? ["lending-implementation-migration-required"] : []),
  ...(lendingImplementation.runtimeCompatible && !lendingActivation.activated
    ? ["lending-fixed-rate-activation-required"]
    : []),
  ...(lendingImplementation.runtimeCompatible
    && lendingActivation.activated
    && !lendingActivation.ready
    ? ["lending-risk-actions-paused-or-unpublished"]
    : []),
];

console.log(JSON.stringify({
  chainId,
  deploymentBlock: deployment.deploymentBlock,
  governance: { mode, address: governance, guardian },
  localManifestConsistent,
  lendingManifestMatchesRuntime,
  topologyOk,
  deployed,
  lending: {
    address: addresses.lending,
    implementation: lendingImplementation,
    activation: lendingActivation,
    accounting: {
      totalSupplyShares: lendingAccounting[0],
      totalBorrowedNusd: lendingAccounting[1],
      totalBadDebtNusd: lendingAccounting[2],
      cashNusd: lendingAccounting[3],
    },
    collateral,
    collateralTopology: {
      count: collateralAssetCount,
      order: collateralAssetOrder,
      ready: lendingCollateralTopologyReady,
    },
    pauses: {
      supply: lendingPauses[0],
      borrow: lendingPauses[1],
      collateralWithdrawal: lendingPauses[2],
    },
    caps: { supplyNusd: lendingCaps[0], borrowNusd: lendingCaps[1] },
  },
  ownership: { coreOwners, corePendingOwners, coreGuardians, coreOwnershipReady },
  graduation: {
    controller: addresses.controller,
    controllerGovernance,
    controllerGuardian,
    pumpAdmin,
    pumpPendingAdmin,
    routerAdmin: pumpRouterAdmin,
    routerPendingAdmin: pumpRouterPendingAdmin,
    routerEnabled,
    adapterAllowed,
    graduationsPaused,
    enableAt: routerEnableAt,
    adapterAt,
    ready: graduationReady,
  },
  pools,
  vaults,
  synthSafetyReserve,
  synthActivation: {
    manifestEnabled: synthManifestEnabled,
    manifestConsistent: synthManifestConsistent,
    runtimeEnabled: synthRuntimeEnabled,
    ready: synthActivationReady,
  },
  retiredSynthMarkets,
  blockingIssues,
  operational,
}, (key, value) => typeof value === "bigint" ? value.toString() : value, 2));

if (!operational && !allowInactive) process.exitCode = 1;
