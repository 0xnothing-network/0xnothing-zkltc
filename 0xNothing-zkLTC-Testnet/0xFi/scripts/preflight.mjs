import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { config as loadEnv } from "dotenv";
import { createPublicClient, fallback, formatEther, formatUnits, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { resolvePrivateKey } from "./lib/private-key.mjs";
import { pumpAdministrationTopology } from "./lib/preflight-topology.mjs";
import { fallbackRpcUrl, primaryRpcUrl, RPC_BATCH_OPTIONS } from "./lib/rpc.mjs";

const root = resolve(import.meta.dirname, "..");
const localEnv = resolve(root, ".env.local");
if (existsSync(localEnv)) loadEnv({ path: localEnv, quiet: true });

const network = JSON.parse(readFileSync(resolve(root, "config/liteforge-testnet.json"), "utf8"));
const { privateKey } = resolvePrivateKey();

const account = privateKeyToAccount(privateKey);
const client = createPublicClient({
  transport: fallback([
    http(primaryRpcUrl(network), { ...RPC_BATCH_OPTIONS, timeout: 15_000, retryCount: 2 }),
    http(fallbackRpcUrl(network), { ...RPC_BATCH_OPTIONS, timeout: 15_000 }),
  ]),
});

const erc20Abi = [
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
];

const nusdAbi = [
  ...erc20Abi,
  {
    type: "function",
    name: "totalCollateralWei",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "reserveValueNusd",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "mintPaused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "redeemPaused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
];

const adminAbi = [
  {
    type: "function",
    name: "admin",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
];

const pumpAbi = [
  ...adminAbi,
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
];

const routerAbi = [
  ...adminAbi,
  {
    type: "function",
    name: "enabled",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "minimumDelay",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
];

const controllerAbi = parseAbi([
  "function pump() view returns (address)",
  "function router() view returns (address)",
  "function adapter() view returns (address)",
  "function governance() view returns (address)",
  "function guardian() view returns (address)",
]);

const feedAbi = [
  {
    type: "function",
    name: "description",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { type: "uint80" },
      { type: "int256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint80" },
    ],
  },
];

const addresses = network.existingContracts;
const [chainId, block, balance, nusdCode, pumpCode, routerCode, lockerCode, diaOracleCode] = await Promise.all([
  client.getChainId(),
  client.getBlock(),
  client.getBalance({ address: account.address }),
  client.getCode({ address: addresses.nusd }),
  client.getCode({ address: addresses.pump }),
  client.getCode({ address: addresses.pumpGraduationRouter }),
  client.getCode({ address: addresses.pumpLiquidityLocker }),
  client.getCode({ address: network.dia.oracleV2 }),
]);

if (chainId !== network.chainId) throw new Error(`Wrong chain: expected ${network.chainId}, received ${chainId}`);
const missingCode = [
  ["NUSD", nusdCode],
  ["Pump", pumpCode],
  ["Pump graduation router", routerCode],
  ["Pump liquidity locker", lockerCode],
  ["DIA oracle", diaOracleCode],
].filter(([, code]) => !code || code === "0x");
if (missingCode.length) throw new Error(`${missingCode.map(([label]) => label).join(", ")} has no bytecode`);

const [totalSupply, totalCollateral, reserveValue, mintPaused, redeemPaused, pumpAdmin, pumpPaused, routerAdmin, routerEnabled, routerDelay] =
  await Promise.all([
    client.readContract({ address: addresses.nusd, abi: nusdAbi, functionName: "totalSupply" }),
    client.readContract({ address: addresses.nusd, abi: nusdAbi, functionName: "totalCollateralWei" }),
    client.readContract({ address: addresses.nusd, abi: nusdAbi, functionName: "reserveValueNusd" }),
    client.readContract({ address: addresses.nusd, abi: nusdAbi, functionName: "mintPaused" }),
    client.readContract({ address: addresses.nusd, abi: nusdAbi, functionName: "redeemPaused" }),
    client.readContract({ address: addresses.pump, abi: pumpAbi, functionName: "admin" }),
    client.readContract({ address: addresses.pump, abi: pumpAbi, functionName: "paused" }),
    client.readContract({ address: addresses.pumpGraduationRouter, abi: routerAbi, functionName: "admin" }),
    client.readContract({ address: addresses.pumpGraduationRouter, abi: routerAbi, functionName: "enabled" }),
    client.readContract({ address: addresses.pumpGraduationRouter, abi: routerAbi, functionName: "minimumDelay" }),
  ]);

const expectedRouterDelay = BigInt(network.pumpGraduation?.minimumDelaySeconds ?? 172_800);
if (routerDelay !== expectedRouterDelay) {
  throw new Error(`Pump graduation delay mismatch: expected ${expectedRouterDelay}, received ${routerDelay}`);
}

const controllerAdminActive = network.deployment?.pumpAdministrationStatus === "controller-admin-active";
const controllerAddress = controllerAdminActive
  ? network.deployment?.contracts?.pumpGraduationController
  : undefined;
let controllerState;
if (controllerAdminActive) {
  if (typeof controllerAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(controllerAddress)) {
    throw new Error("Recorded graduation controller is not a valid address");
  }
  const controllerCode = await client.getCode({ address: controllerAddress });
  if (!controllerCode || controllerCode === "0x") throw new Error("Graduation controller has no bytecode");
  const [pump, router, adapter, governance, guardian] = await Promise.all([
    client.readContract({ address: controllerAddress, abi: controllerAbi, functionName: "pump" }),
    client.readContract({ address: controllerAddress, abi: controllerAbi, functionName: "router" }),
    client.readContract({ address: controllerAddress, abi: controllerAbi, functionName: "adapter" }),
    client.readContract({ address: controllerAddress, abi: controllerAbi, functionName: "governance" }),
    client.readContract({ address: controllerAddress, abi: controllerAbi, functionName: "guardian" }),
  ]);
  controllerState = { pump, router, adapter, governance, guardian };
}
const administration = pumpAdministrationTopology({
  account: account.address,
  pump: addresses.pump,
  router: addresses.pumpGraduationRouter,
  pumpAdmin,
  routerAdmin,
  deployment: network.deployment,
  controllerState,
});

const now = block.timestamp;
const feeds = {};
for (const [symbol, address] of Object.entries(network.dia.feeds)) {
  const code = await client.getCode({ address });
  if (!code || code === "0x") throw new Error(`DIA ${symbol} feed has no bytecode`);
  const [description, decimals, round] = await Promise.all([
    client.readContract({ address, abi: feedAbi, functionName: "description" }),
    client.readContract({ address, abi: feedAbi, functionName: "decimals" }),
    client.readContract({ address, abi: feedAbi, functionName: "latestRoundData" }),
  ]);
  const roundId = round[0];
  const answer = round[1];
  const updatedAt = round[3];
  const answeredInRound = round[4];
  const ageSeconds = now > updatedAt ? now - updatedAt : 0n;
  if (
    answer <= 0n
    || updatedAt === 0n
    || updatedAt > now
    || answeredInRound < roundId
    || ageSeconds > BigInt(network.dia.maximumAcceptedAgeSeconds)
  ) {
    throw new Error(`DIA ${symbol} feed is invalid or stale`);
  }
  if (description !== network.dia.keys[symbol]) {
    throw new Error(`DIA ${symbol} description mismatch: expected ${network.dia.keys[symbol]}, received ${description}`);
  }
  if (decimals !== network.dia.decimals) {
    throw new Error(`DIA ${symbol} decimals mismatch: expected ${network.dia.decimals}, received ${decimals}`);
  }
  feeds[symbol] = {
    address,
    description,
    priceUsd: formatUnits(answer, decimals),
    updatedAt: updatedAt.toString(),
    ageSeconds: ageSeconds.toString(),
  };
}

// NUSD coverage is now an informational economic-health metric, not an on-chain
// admission gate. The health guard was removed in the guard-removal migration;
// risk actions are gated only by DIA freshness, caps, and pauses. A reference
// coverage floor is kept purely for the surfaced warning below.
const REFERENCE_COVERAGE_FLOOR_BPS = 10_500n;
const coverageBps = totalSupply === 0n ? 10_000n : (reserveValue * 10_000n) / totalSupply;
const coverageAboveReference = coverageBps >= REFERENCE_COVERAGE_FLOOR_BPS;

const report = {
  chainId,
  blockNumber: block.number.toString(),
  deployer: account.address,
  deployerBalanceZkLtc: formatEther(balance),
  existing: {
    nusd: addresses.nusd,
    pump: addresses.pump,
    pumpGraduationRouter: addresses.pumpGraduationRouter,
    pumpLiquidityLocker: addresses.pumpLiquidityLocker,
  },
  nusd: {
    totalSupply: formatEther(totalSupply),
    totalCollateralZkLtc: formatEther(totalCollateral),
    reserveValueNusd: formatEther(reserveValue),
    coverageBps: coverageBps.toString(),
    referenceCoverageFloorBps: REFERENCE_COVERAGE_FLOOR_BPS.toString(),
    coverageAboveReference,
    coverageAdmissionGate: false,
    mintPaused,
    redeemPaused,
  },
  pump: { admin: pumpAdmin, paused: pumpPaused },
  pumpAdministration: administration,
  graduationRouter: {
    admin: routerAdmin,
    enabled: routerEnabled,
    minimumDelaySeconds: routerDelay.toString(),
    expectedMinimumDelaySeconds: expectedRouterDelay.toString(),
  },
  diaFeeds: feeds,
};

console.log(JSON.stringify(report, null, 2));
