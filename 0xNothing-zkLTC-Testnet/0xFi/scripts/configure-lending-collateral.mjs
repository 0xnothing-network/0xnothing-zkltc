import process from "node:process";

import { parseAbi } from "viem";

import {
  governanceAddress,
  governanceMode,
  loadRuntime,
  requiredAddress,
  saveRuntime,
  sendContract,
} from "./lib/graduation-runtime.mjs";

const broadcast = process.argv.includes("--broadcast");
if (process.argv.some((argument) => argument.startsWith("--") && argument !== "--broadcast")) {
  throw new Error("Usage: npm run lending:collateral:check or npm run lending:collateral:configure");
}

const runtime = loadRuntime({ wallet: true });
const { deployment, network, publicClient, account } = runtime;
const chainId = await publicClient.getChainId();
if (chainId !== Number(network.chainId)) {
  throw new Error(`Wrong chain: expected ${network.chainId}, received ${chainId}`);
}

const lendingPool = requiredAddress(deployment.lendingPool, "lending pool");
const governance = governanceAddress(deployment);
const mode = governanceMode(deployment);
const lendingAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function collateralConfigs(address asset) view returns (address oracle,uint256 supplyCap,uint16 loanToValueBps,uint16 liquidationThresholdBps,uint16 liquidationBonusBps,uint8 decimals,bool enabled)",
  "function configureCollateral(address asset,address oracle,uint256 supplyCap,uint16 loanToValueBps,uint16 liquidationThresholdBps,uint16 liquidationBonusBps,bool enabled)",
]);
const oracleAbi = parseAbi(["function isFresh() view returns (bool)"]);

function positiveBigInt(value, fallback, label) {
  const raw = value?.trim() || String(fallback);
  if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) throw new Error(`${label} must be a positive integer`);
  return BigInt(raw);
}

const configurations = [
  {
    key: "wzkLTC",
    asset: requiredAddress(deployment.wzkLTC, "WzkLTC"),
    oracle: requiredAddress(deployment.ltcOracle, "LTC oracle"),
    cap: positiveBigInt(process.env.WZKLTC_COLLATERAL_CAP, deployment.wzkLtcCollateralCap, "WZKLTC_COLLATERAL_CAP"),
  },
  {
    key: "nBTC",
    asset: requiredAddress(deployment.nBTC, "nBTC"),
    oracle: requiredAddress(deployment.btcOracle, "BTC oracle"),
    cap: positiveBigInt(
      process.env.NBTC_LENDING_COLLATERAL_CAP,
      deployment.nBTCLendingCollateralCap || deployment.nBTCDebtCeiling,
      "NBTC_LENDING_COLLATERAL_CAP",
    ),
  },
  {
    key: "nETH",
    asset: requiredAddress(deployment.nETH, "nETH"),
    oracle: requiredAddress(deployment.ethOracle, "ETH oracle"),
    cap: positiveBigInt(
      process.env.NETH_LENDING_COLLATERAL_CAP,
      deployment.nETHLendingCollateralCap || deployment.nETHDebtCeiling,
      "NETH_LENDING_COLLATERAL_CAP",
    ),
  },
];

const [owner, pendingOwner] = await Promise.all([
  publicClient.readContract({ address: lendingPool, abi: lendingAbi, functionName: "owner" }),
  publicClient.readContract({ address: lendingPool, abi: lendingAbi, functionName: "pendingOwner" }),
]);

const state = [];
for (const configuration of configurations) {
  const [current, oracleFresh] = await Promise.all([
    publicClient.readContract({
      address: lendingPool,
      abi: lendingAbi,
      functionName: "collateralConfigs",
      args: [configuration.asset],
    }),
    publicClient.readContract({ address: configuration.oracle, abi: oracleAbi, functionName: "isFresh" }),
  ]);
  const matches = current[0].toLowerCase() === configuration.oracle.toLowerCase()
    && current[1] === configuration.cap
    && current[2] === 5000
    && current[3] === 6500
    && current[4] === 500
    && current[5] === 18
    && current[6];
  state.push({ ...configuration, current, oracleFresh, matches });
}

const changes = state.filter((item) => !item.matches);
if (changes.some((item) => !item.oracleFresh)) {
  throw new Error("Refusing to enable collateral while a configured oracle is stale");
}
if (changes.length && owner.toLowerCase() !== account.address.toLowerCase()) {
  throw new Error(`Lending configuration requires current owner ${owner}; configured wallet is ${account.address}`);
}
if (changes.length && mode !== "timelock" && pendingOwner.toLowerCase() !== "0x0000000000000000000000000000000000000000") {
  throw new Error("Lending pool has a conflicting pending owner during direct governance or transition");
}
if (changes.length && mode === "timelock"
  && pendingOwner.toLowerCase() !== governance.toLowerCase()
  && owner.toLowerCase() !== governance.toLowerCase()) {
  throw new Error("Lending pool pending owner does not match governance");
}

for (const item of changes) {
  await publicClient.simulateContract({
    account,
    address: lendingPool,
    abi: lendingAbi,
    functionName: "configureCollateral",
    args: [item.asset, item.oracle, item.cap, 5000, 6500, 500, true],
  });
}

if (!broadcast) {
  console.log(JSON.stringify({
    mode: "check",
    governanceMode: mode,
    governance,
    lendingPool,
    owner,
    pendingOwner,
    changesRequired: changes.map((item) => item.key),
    assets: state.map((item) => ({
      symbol: item.key,
      configured: item.matches,
      oracleFresh: item.oracleFresh,
      supplyCap: item.cap.toString(),
    })),
  }, null, 2));
  process.exit(0);
}

const hashes = [];
for (const item of changes) {
  const { hash } = await sendContract(
    runtime,
    lendingPool,
    lendingAbi,
    "configureCollateral",
    [item.asset, item.oracle, item.cap, 5000, 6500, 500, true],
  );
  hashes.push(hash);
}

for (const item of configurations) {
  const configured = await publicClient.readContract({
    address: lendingPool,
    abi: lendingAbi,
    functionName: "collateralConfigs",
    args: [item.asset],
  });
  if (
    configured[0].toLowerCase() !== item.oracle.toLowerCase()
    || configured[1] !== item.cap
    || configured[2] !== 5000
    || configured[3] !== 6500
    || configured[4] !== 500
    || configured[5] !== 18
    || !configured[6]
  ) throw new Error(`Post-configuration verification failed for ${item.key}`);
}

deployment.wzkLtcCollateralCap = configurations[0].cap.toString();
deployment.nBTCLendingCollateralCap = configurations[1].cap.toString();
deployment.nETHLendingCollateralCap = configurations[2].cap.toString();
deployment.lendingCollateralConfigurationStatus = "configured-three-assets-oracle-capped";
deployment.lendingCollateralConfigurationHashes = [
  ...(deployment.lendingCollateralConfigurationHashes || []),
  ...hashes,
];
deployment.transactionHashes = [...new Set([...(deployment.transactionHashes || []), ...hashes])];
network.deployment.lendingCollateralConfigurationStatus = deployment.lendingCollateralConfigurationStatus;
network.deployment.lendingCollateralCaps = {
  wzkLTC: deployment.wzkLtcCollateralCap,
  nBTC: deployment.nBTCLendingCollateralCap,
  nETH: deployment.nETHLendingCollateralCap,
};
saveRuntime(network, deployment);

console.log(JSON.stringify({
  mode: "broadcast",
  governanceMode: mode,
  governance,
  lendingPool,
  configuredAssets: configurations.map((item) => item.key),
  transactionsSent: hashes.length,
  transactionHashes: hashes,
  oracleFreshness: Object.fromEntries(state.map((item) => [item.key, item.oracleFresh])),
}, null, 2));
