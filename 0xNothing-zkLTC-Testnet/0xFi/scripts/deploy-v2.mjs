#!/usr/bin/env node
// Testnet v2 deployment (new tokenomics). One orchestrator for both Foundry roots:
//   --rehearse   full run on a local anvil fork of LiteForge: deploy, seed, smoke-test, warp, activate
//   --broadcast  live deploy (core, then 0xFi) and seed liquidity; resumable stage by stage
//   --activate   live, once the 1-hour graduation delay has passed: open graduation, hand admin to the controller
//   --publish    switch the repo's active testnet set (network config, 0xFi subgraph config, web config) to v2
//   --status     read-only summary
// The deployer key is read from the testnet .env.local into memory and only handed to forge through the child env.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEther,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { atomicWriteFile } from "./lib/graduation-runtime.mjs";
import { CURRENT_LENDING_IMPLEMENTATION_STATUS } from "./lib/lending-implementation.mjs";
import { publicGeneratedConfigTarget, publicTestnetConfiguration } from "./lib/public-environment.mjs";
import { primaryRpcUrl } from "./lib/rpc.mjs";
import { runStep } from "./lib/spawn-step.mjs";

const fiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testnetRoot = path.resolve(fiRoot, "..");
const coreContracts = path.join(testnetRoot, "contracts");
const fiContracts = path.join(fiRoot, "contracts");
const manifestPath = path.join(testnetRoot, "deployments", "liteforge-testnet", "v2.json");
const network = JSON.parse(fs.readFileSync(path.join(fiRoot, "config", "liteforge-testnet.json"), "utf8"));

const modes = ["--rehearse", "--broadcast", "--activate", "--publish", "--status"];
const flags = process.argv.slice(2).filter((argument) => argument.startsWith("--"));
if (flags.length !== 1 || !modes.includes(flags[0])) throw new Error(`Choose exactly one of ${modes.join(", ")}`);
const mode = flags[0];

const CHAIN_ID = 4441;
const GOLDSKY_PROJECT = "project_cmqmpust19i8v01t595z8hpq4";
const FI_SUBGRAPH = "zeroxfi-testnet-v2/0.2.0";
const PUMP_SUBGRAPH = "zeroxpump-testnet-v2/0.2.0";
const NUSD_MARKET_SUBGRAPH = "pixel-nusd-market-v2/1.0.0";
const goldskyEndpoint = (name) => `https://api.goldsky.com/api/public/${GOLDSKY_PROJECT}/subgraphs/${name}/gn`;
const ANVIL_PORT = 8547;
const MIN_LIVE_BALANCE = parseEther("2.5");
const SEED_MINT_ZKLTC = parseEther("1");
const SEED_CORE_ZKLTC = parseEther("0.5");
const SEED_NBTC = parseEther("0.00002");
const SEED_NETH = parseEther("0.001");

const chain = defineChain({
  id: CHAIN_ID,
  name: network.name,
  nativeCurrency: network.nativeCurrency,
  rpcUrls: { default: { http: [primaryRpcUrl(network)] } },
});

const nusdAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function quoteMint(uint256) view returns (uint256)",
  "function mintAtOracle(uint256 minNusdOut,address recipient) payable returns (uint256)",
  "function reserveValueNusd() view returns (uint256)",
  "function surplusMintCapacity() view returns (uint256 amountNusd,bool triggerReached)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const oracleAbi = parseAbi([
  "function readPriceWad() view returns (uint256 priceWad,uint256 updatedAt,uint80 roundId)",
  "function isFresh() view returns (bool)",
]);
const routerAbi = parseAbi([
  "struct AddLiquidityParams { address tokenA; address tokenB; uint256 amountADesired; uint256 amountBDesired; uint256 amountAMin; uint256 amountBMin; uint256 minimumLiquidity; address to; uint256 deadline; }",
  "struct AddLiquidityNativeParams { address token; uint256 amountTokenDesired; uint256 amountTokenMin; uint256 amountNativeMin; uint256 minimumLiquidity; address to; uint256 deadline; }",
  "function addLiquidity(AddLiquidityParams params) returns (uint256,uint256,uint256)",
  "function addLiquidityNative(AddLiquidityNativeParams params) payable returns (uint256,uint256,uint256)",
  "function swapExactTokensForNative(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[])",
  "function swapExactNativeForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable returns (uint256[])",
  "function accruedRouterFees(address) view returns (uint256)",
  "function distributeFees(address token) returns (uint256)",
]);
const pairAbi = parseAbi(["function getReserves() view returns (uint112,uint112,uint32)"]);
const vaultAbi = parseAbi([
  "function quoteMintFee(uint256 amountSynthetic) view returns (uint256)",
  "function depositAndMint(uint256 collateralNusd,uint256 amountSynthetic,uint256 maxFeeNusd,address recipient)",
]);
const pumpAbi = parseAbi([
  "function admin() view returns (address)",
  "function pendingAdmin() view returns (address)",
  "function transferAdmin(address newAdmin)",
  "function reserveMarket(bytes32 commitment)",
  "function createMarket(string name,string symbol,string metadataURI,string imageURI,bytes32 commitment) returns (address)",
  "function createdTokenByContentHash(address creator,bytes32 contentHash) view returns (address)",
  "function buy(address token,uint256 maxNusdIn,uint256 minTokenOut,uint256 deadline) returns (uint256,uint256)",
  "function accruedProtocolFeesNusd() view returns (uint256)",
  "function distributeFees() returns (uint256)",
]);
const pumpRouterAbi = parseAbi([
  "function admin() view returns (address)",
  "function pendingAdmin() view returns (address)",
  "function enabled() view returns (bool)",
  "function enableAt() view returns (uint256)",
  "function isAdapterAllowed(address) view returns (bool)",
  "function adapterActivationTime(address) view returns (uint256)",
  "function activateAdapter(address adapter)",
  "function enableRouter()",
  "function transferAdmin(address newAdmin)",
]);
const controllerAbi = parseAbi([
  "function acceptProtocolAdmin()",
  "function governance() view returns (address)",
]);
const stakingAbi = parseAbi([
  "function stake(uint256 amount,uint32 lockDuration) returns (uint256)",
  "function accountState(address) view returns (uint256 weight,uint256 openPoints,uint256 claimable)",
  "function availableRewards() view returns (uint256)",
]);
const governorAbi = parseAbi(["function propose() returns (uint256)"]);
const marketAbi = parseAbi([
  "function quoteSale(address collection,uint256 tokenId,uint256 price) view returns (uint256 burnAmount,address creator,uint256 creatorFee,uint256 sellerProceeds)",
]);
const royaltyAbi = parseAbi(["function royaltyInfo(uint256,uint256) view returns (address,uint256)"]);
const marketAdminAbi = parseAbi([
  "function collectionAllowed(address) view returns (bool)",
  "function setCollectionAllowed(address collection,bool allowed)",
]);
const lendingAbi = parseAbi(["function sweepProtocolInterest() returns (uint256)"]);

const CORE_KEYS = [
  "nusd", "treasury", "rewardStaking", "feeSplitter", "surplusMintGovernor", "pumpLiquidityLocker",
  "pumpGraduationRouter", "pump", "nusdMarketplace",
];
const FI_KEYS = [
  "dexFactory", "dexRouter", "pumpGraduationAdapter", "pumpGraduationController", "gaugeFactory",
  "synthSafetyReserve", "nBTC", "nETH", "nBTCVault", "nETHVault", "lendingPool", "lpLocker",
  "tokenMetadataRegistry", "wzkLtcNusdPair", "nBTCNusdPair", "nETHNusdPair", "wzkLtcNusdGauge",
  "nBTCNusdGauge", "nETHNusdGauge",
];

// Same source as the other testnet operator scripts: the testnet root .env.local, parsed in memory only.
function loadDeployerKey() {
  const environment = dotenv.parse(fs.readFileSync(path.join(testnetRoot, ".env.local"), "utf8"));
  const supplied = String(environment.DEPLOYER_PRIVATE_KEY || environment.PRIVATE_KEY || "").trim();
  const key = supplied.startsWith("0x") ? supplied : `0x${supplied}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Missing deployment key in the testnet .env.local");
  return key;
}
const privateKey = loadDeployerKey();
const account = privateKeyToAccount(privateKey);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function same(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

function clientsFor(url) {
  const transport = http(url, { timeout: 30_000, retryCount: 3 });
  return {
    url,
    publicClient: createPublicClient({ chain, transport }),
    walletClient: createWalletClient({ chain, transport, account }),
  };
}

async function send(ctx, address, abi, functionName, args = [], value = 0n) {
  const { request } = await ctx.publicClient.simulateContract({ address, abi, functionName, args, value, account });
  const hash = await ctx.walletClient.writeContract(request);
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  console.log(`  ${functionName} ${hash}`);
  return receipt;
}

async function read(ctx, address, abi, functionName, args = []) {
  return ctx.publicClient.readContract({ address, abi, functionName, args });
}

async function expectRevert(ctx, address, abi, functionName, args, label) {
  try {
    await ctx.publicClient.simulateContract({ address, abi, functionName, args, account });
  } catch {
    return;
  }
  throw new Error(`${label}: expected a revert`);
}

async function deadline(ctx) {
  const block = await ctx.publicClient.getBlock();
  return block.timestamp + 1200n;
}

async function requireCode(ctx, addresses) {
  for (const [key, address] of Object.entries(addresses)) {
    const code = await ctx.publicClient.getCode({ address });
    if (!code || code === "0x") throw new Error(`No bytecode at ${key} ${address}`);
  }
}

// ------------------------------------------------------------------ stages

async function deployCore(ctx, suffix) {
  console.log("Deploying v2 core (NUSD v2, treasury, splitter, staking, governor, Pump v2, marketplace v2)");
  await runStep(
    "forge",
    ["script", "script/DeployV2Core.s.sol:DeployV2Core", "--rpc-url", ctx.url, "--broadcast", "--slow"],
    { PRIVATE_KEY: privateKey, V2_MANIFEST_SUFFIX: suffix },
    coreContracts,
  );
  const core = readJson(path.join(coreContracts, "deployments", `v2-core${suffix}.json`));
  const addresses = Object.fromEntries(CORE_KEYS.map((key) => [key, getAddress(core[key])]));
  await requireCode(ctx, addresses);
  const pixelV1 = getAddress(core.pixelV1);
  if (!(await read(ctx, addresses.nusdMarketplace, marketAdminAbi, "collectionAllowed", [pixelV1]))) {
    await send(ctx, addresses.nusdMarketplace, marketAdminAbi, "setCollectionAllowed", [pixelV1, true]);
  }
  return { ...addresses, pixelV1, pixelV2: getAddress(core.pixelV2) };
}

async function deployFi(ctx, core, suffix) {
  console.log("Deploying v2 0xFi (hub factory, router, lending, synths, gauges, graduation)");
  await runStep(
    "forge",
    ["script", "script/Deploy0xFiV2.s.sol:Deploy0xFiV2", "--rpc-url", ctx.url, "--broadcast", "--slow"],
    {
      PRIVATE_KEY: privateKey,
      V2_MANIFEST_SUFFIX: suffix,
      V2_NUSD: core.nusd,
      V2_PUMP: core.pump,
      V2_PUMP_GRADUATION_ROUTER: core.pumpGraduationRouter,
      V2_FEE_SPLITTER: core.feeSplitter,
      V2_TREASURY: core.treasury,
    },
    fiContracts,
  );
  const fi = readJson(path.join(fiContracts, "deployments", `v2-fi${suffix}.json`));
  const addresses = Object.fromEntries(FI_KEYS.map((key) => [key, getAddress(fi[key])]));
  await requireCode(ctx, addresses);
  return {
    ...addresses,
    wzkLTC: getAddress(fi.wzkLTC),
    ltcOracle: getAddress(fi.ltcOracle),
    btcOracle: getAddress(fi.btcOracle),
    ethOracle: getAddress(fi.ethOracle),
  };
}

async function priceOf(ctx, oracle) {
  const [priceWad] = await read(ctx, oracle, oracleAbi, "readPriceWad");
  return priceWad;
}

async function seedLiquidity(ctx, c) {
  console.log("Seeding WzkLTC/NUSD, nBTC/NUSD and nETH/NUSD liquidity at oracle prices");
  const me = account.address;
  const minted = await read(ctx, c.nusd, nusdAbi, "quoteMint", [SEED_MINT_ZKLTC]);
  await send(ctx, c.nusd, nusdAbi, "mintAtOracle", [(minted * 99n) / 100n, me], SEED_MINT_ZKLTC);

  const coreNusd = await read(ctx, c.nusd, nusdAbi, "quoteMint", [SEED_CORE_ZKLTC]);
  await send(ctx, c.nusd, nusdAbi, "approve", [c.dexRouter, coreNusd]);
  await send(ctx, c.dexRouter, routerAbi, "addLiquidityNative", [{
    token: c.nusd,
    amountTokenDesired: coreNusd,
    amountTokenMin: coreNusd,
    amountNativeMin: SEED_CORE_ZKLTC,
    minimumLiquidity: 1n,
    to: me,
    deadline: await deadline(ctx),
  }], SEED_CORE_ZKLTC);

  for (const [asset, vault, oracle, amount] of [
    [c.nBTC, c.nBTCVault, c.btcOracle, SEED_NBTC],
    [c.nETH, c.nETHVault, c.ethOracle, SEED_NETH],
  ]) {
    const value = (amount * (await priceOf(ctx, oracle))) / 10n ** 18n;
    const collateral = value * 2n; // 200%, above the vault's 150% minimum
    const fee = await read(ctx, vault, vaultAbi, "quoteMintFee", [amount]);
    await send(ctx, c.nusd, nusdAbi, "approve", [vault, collateral + fee]);
    await send(ctx, vault, vaultAbi, "depositAndMint", [collateral, amount, fee, me]);
    await send(ctx, asset, erc20Abi, "approve", [c.dexRouter, amount]);
    await send(ctx, c.nusd, nusdAbi, "approve", [c.dexRouter, value]);
    await send(ctx, c.dexRouter, routerAbi, "addLiquidity", [{
      tokenA: asset,
      tokenB: c.nusd,
      amountADesired: amount,
      amountBDesired: value,
      amountAMin: amount,
      amountBMin: value,
      minimumLiquidity: 1n,
      to: me,
      deadline: await deadline(ctx),
    }]);
  }

  const reserves = {};
  for (const key of ["wzkLtcNusdPair", "nBTCNusdPair", "nETHNusdPair"]) {
    const [r0, r1] = await read(ctx, c[key], pairAbi, "getReserves");
    if (r0 === 0n || r1 === 0n) throw new Error(`${key} has no liquidity after seeding`);
    reserves[key] = [r0.toString(), r1.toString()];
  }
  return reserves;
}

async function graduationReadyAt(ctx, c) {
  const [adapterAt, enableAt] = await Promise.all([
    read(ctx, c.pumpGraduationRouter, pumpRouterAbi, "adapterActivationTime", [c.pumpGraduationAdapter]),
    read(ctx, c.pumpGraduationRouter, pumpRouterAbi, "enableAt"),
  ]);
  return adapterAt > enableAt ? adapterAt : enableAt;
}

async function activateGraduation(ctx, c) {
  console.log("Opening graduation and handing Pump + router admin to the graduation controller");
  const router = c.pumpGraduationRouter;
  if (!(await read(ctx, router, pumpRouterAbi, "isAdapterAllowed", [c.pumpGraduationAdapter]))) {
    await send(ctx, router, pumpRouterAbi, "activateAdapter", [c.pumpGraduationAdapter]);
  }
  if (!(await read(ctx, router, pumpRouterAbi, "enabled"))) await send(ctx, router, pumpRouterAbi, "enableRouter");
  if (same(await read(ctx, c.pump, pumpAbi, "admin"), account.address)
    && !same(await read(ctx, c.pump, pumpAbi, "pendingAdmin"), c.pumpGraduationController)) {
    await send(ctx, c.pump, pumpAbi, "transferAdmin", [c.pumpGraduationController]);
  }
  if (same(await read(ctx, router, pumpRouterAbi, "admin"), account.address)
    && !same(await read(ctx, router, pumpRouterAbi, "pendingAdmin"), c.pumpGraduationController)) {
    await send(ctx, router, pumpRouterAbi, "transferAdmin", [c.pumpGraduationController]);
  }
  if (!same(await read(ctx, c.pump, pumpAbi, "admin"), c.pumpGraduationController)) {
    await send(ctx, c.pumpGraduationController, controllerAbi, "acceptProtocolAdmin");
  }
  const [pumpAdmin, routerAdmin, enabled, governance] = await Promise.all([
    read(ctx, c.pump, pumpAbi, "admin"),
    read(ctx, router, pumpRouterAbi, "admin"),
    read(ctx, router, pumpRouterAbi, "enabled"),
    read(ctx, c.pumpGraduationController, controllerAbi, "governance"),
  ]);
  if (!same(pumpAdmin, c.pumpGraduationController) || !same(routerAdmin, c.pumpGraduationController) || !enabled
    || !same(governance, account.address)) {
    throw new Error("Graduation activation did not reach the expected admin state");
  }
}

/// Fork-only: exercises every new revenue path on the real deployed bytecode.
async function smokeTest(ctx, c) {
  console.log("Smoke-testing fee routing, staking, governor, marketplace and Pump v2");
  const me = account.address;
  const nusdOf = (holder) => read(ctx, c.nusd, nusdAbi, "balanceOf", [holder]);

  // 0xFi: NUSD -> zkLTC pays 0.1% in NUSD; zkLTC -> NUSD pays 0.1% in WzkLTC.
  await send(ctx, c.nusd, nusdAbi, "approve", [c.dexRouter, parseEther("1")]);
  await send(ctx, c.dexRouter, routerAbi, "swapExactTokensForNative", [parseEther("1"), 0n, [c.nusd, c.wzkLTC], me, await deadline(ctx)]);
  if ((await read(ctx, c.dexRouter, routerAbi, "accruedRouterFees", [c.nusd])) !== parseEther("0.001")) {
    throw new Error("Router NUSD fee is not 0.1% of the input");
  }
  await send(ctx, c.dexRouter, routerAbi, "swapExactNativeForTokens", [0n, [c.wzkLTC, c.nusd], me, await deadline(ctx)], parseEther("0.01"));
  const stakingBefore = await nusdOf(c.rewardStaking);
  const treasuryBefore = await nusdOf(c.treasury);
  await send(ctx, c.dexRouter, routerAbi, "distributeFees", [c.nusd]);
  await send(ctx, c.dexRouter, routerAbi, "distributeFees", [c.wzkLTC]);
  if ((await nusdOf(c.rewardStaking)) - stakingBefore !== parseEther("0.0005")
    || (await nusdOf(c.treasury)) - treasuryBefore !== parseEther("0.0005")) {
    throw new Error("Router NUSD fee was not split 50/50");
  }
  if ((await read(ctx, c.wzkLTC, erc20Abi, "balanceOf", [c.treasury])) !== parseEther("0.00001")) {
    throw new Error("Router WzkLTC fee did not reach the treasury");
  }

  // 0xPump v2: creation fee + 10 bps buy fee reach the pool through one permissionless call.
  const commitment = keccak256(toHex(`v2-rehearsal-${Date.now()}`));
  await send(ctx, c.nusd, nusdAbi, "approve", [c.pump, parseEther("5")]);
  await send(ctx, c.pump, pumpAbi, "reserveMarket", [commitment]);
  await send(ctx, c.pump, pumpAbi, "createMarket", ["Rehearsal", "REH", "ipfs://bafybeimetadata", "ipfs://bafybeiimage", commitment]);
  const token = await read(ctx, c.pump, pumpAbi, "createdTokenByContentHash", [me, commitment]);
  await send(ctx, c.pump, pumpAbi, "buy", [token, parseEther("2"), 0n, await deadline(ctx)]);
  const pumpFees = await read(ctx, c.pump, pumpAbi, "accruedProtocolFeesNusd");
  const beforePump = await nusdOf(c.rewardStaking);
  await send(ctx, c.pump, pumpAbi, "distributeFees");
  if ((await nusdOf(c.rewardStaking)) - beforePump !== pumpFees / 2n) throw new Error("Pump fees were not split");

  // 0xPoints staking, governor gate, lending sweep gate, surplus capacity.
  await send(ctx, c.nusd, nusdAbi, "approve", [c.rewardStaking, parseEther("1")]);
  await send(ctx, c.rewardStaking, stakingAbi, "stake", [parseEther("1"), 30 * 24 * 3600]);
  const [weight] = await read(ctx, c.rewardStaking, stakingAbi, "accountState", [me]);
  if (weight !== parseEther("1")) throw new Error("Staking weight mismatch");
  const [, triggerReached] = await read(ctx, c.nusd, nusdAbi, "surplusMintCapacity");
  if (triggerReached) throw new Error("Fresh NUSD v2 unexpectedly reports a 3x surplus");
  await expectRevert(ctx, c.surplusMintGovernor, governorAbi, "propose", [], "propose below 3x");
  await expectRevert(ctx, c.lendingPool, lendingAbi, "sweepProtocolInterest", [], "sweep with no interest");

  // Marketplace v2 on the real Pixel V2 collection: 0.1% burn, 0.4% to the ERC-2981 creator.
  const [burnAmount, creator, creatorFee] = await read(ctx, c.nusdMarketplace, marketAbi, "quoteSale", [c.pixelV2, 1n, parseEther("100")]);
  const [royaltyReceiver] = await read(ctx, c.pixelV2, royaltyAbi, "royaltyInfo", [1n, parseEther("100")]);
  if (burnAmount !== parseEther("0.1") || creatorFee !== parseEther("0.4") || !same(creator, royaltyReceiver)) {
    throw new Error("Marketplace v2 quote does not follow the 0.1% burn / 0.4% creator schedule");
  }
  console.log("  smoke tests passed");
}

async function deploymentBlock(ctx) {
  const blocks = [];
  for (const journal of [
    path.join(coreContracts, "broadcast", "DeployV2Core.s.sol", String(CHAIN_ID), "run-latest.json"),
    path.join(fiContracts, "broadcast", "Deploy0xFiV2.s.sol", String(CHAIN_ID), "run-latest.json"),
  ]) {
    if (!fs.existsSync(journal)) continue;
    for (const receipt of readJson(journal).receipts || []) blocks.push(BigInt(receipt.blockNumber));
  }
  if (!blocks.length) return (await ctx.publicClient.getBlockNumber()).toString();
  return blocks.reduce((min, value) => (value < min ? value : min)).toString();
}

function writeManifest(manifest) {
  atomicWriteFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

// ------------------------------------------------------------------ modes

async function waitForRpc(url) {
  const client = createPublicClient({ chain, transport: http(url, { timeout: 2_000, retryCount: 0 }) });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await client.getChainId();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error("anvil did not start");
}

async function rehearse() {
  const url = `http://127.0.0.1:${ANVIL_PORT}`;
  const anvil = spawn("anvil", ["--fork-url", primaryRpcUrl(network), "--port", String(ANVIL_PORT), "--silent"], {
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    await waitForRpc(url);
    const ctx = clientsFor(url);
    const core = await deployCore(ctx, ".rehearsal");
    const fi = await deployFi(ctx, core, ".rehearsal");
    const c = { ...core, ...fi };
    const reserves = await seedLiquidity(ctx, c);
    await smokeTest(ctx, c);
    const readyAt = await graduationReadyAt(ctx, c);
    const now = (await ctx.publicClient.getBlock()).timestamp;
    await ctx.publicClient.request({ method: "evm_increaseTime", params: [toHex(readyAt - now + 1n)] });
    await ctx.publicClient.request({ method: "evm_mine", params: [] });
    await activateGraduation(ctx, c);
    const spent = (await ctx.publicClient.getBalance({ address: account.address }));
    console.log(JSON.stringify({ mode: "rehearsal", passed: true, reserves, deployerBalanceAfter: formatEther(spent) }, null, 2));
  } finally {
    anvil.kill();
  }
}

async function broadcastLive() {
  const ctx = clientsFor(primaryRpcUrl(network));
  if ((await ctx.publicClient.getChainId()) !== CHAIN_ID) throw new Error("Wrong chain");
  let manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : { stage: "none" };
  if (manifest.stage === "seeded" || manifest.stage === "active") throw new Error("v2 is already deployed");

  if (manifest.stage === "none") {
    const balance = await ctx.publicClient.getBalance({ address: account.address });
    if (balance < MIN_LIVE_BALANCE) throw new Error(`Deployer balance ${formatEther(balance)} zkLTC is below 2.5`);
    for (const oracle of [network.deployment.contracts.ltcOracle, network.deployment.contracts.btcOracle, network.deployment.contracts.ethOracle]) {
      if (!(await read(ctx, oracle, oracleAbi, "isFresh"))) throw new Error(`Oracle ${oracle} is stale; seeding would fail`);
    }
    const core = await deployCore(ctx, "");
    manifest = { chainId: CHAIN_ID, deployer: account.address, stage: "core", core };
    writeManifest(manifest);
  }
  if (manifest.stage === "core") {
    const fi = await deployFi(ctx, manifest.core, "");
    manifest = { ...manifest, stage: "fi", fi, deploymentBlock: await deploymentBlock(ctx) };
    writeManifest(manifest);
  }
  if (manifest.stage === "fi") {
    const c = { ...manifest.core, ...manifest.fi };
    const reserves = await seedLiquidity(ctx, c);
    const readyAt = await graduationReadyAt(ctx, c);
    manifest = {
      ...manifest,
      stage: "seeded",
      seededReserves: reserves,
      graduationReadyAt: new Date(Number(readyAt) * 1000).toISOString(),
      deployedAt: new Date().toISOString(),
    };
    writeManifest(manifest);
  }
  console.log(JSON.stringify({ stage: manifest.stage, graduationReadyAt: manifest.graduationReadyAt, manifest: manifestPath }, null, 2));
}

async function activateLive() {
  const ctx = clientsFor(primaryRpcUrl(network));
  const manifest = readJson(manifestPath);
  if (manifest.stage !== "seeded") throw new Error(`Expected stage "seeded", found "${manifest.stage}"`);
  const c = { ...manifest.core, ...manifest.fi };
  const readyAt = await graduationReadyAt(ctx, c);
  const now = (await ctx.publicClient.getBlock()).timestamp;
  if (now < readyAt) throw new Error(`Graduation delay ends at ${new Date(Number(readyAt) * 1000).toISOString()}`);
  await activateGraduation(ctx, c);
  writeManifest({ ...manifest, stage: "active", activatedAt: new Date().toISOString() });
  console.log(JSON.stringify({ stage: "active" }, null, 2));
}

/// Creation block of every v2 contract, from the local Foundry journals of the live run.
function contractBlocks() {
  const blocks = {};
  for (const journal of [
    path.join(coreContracts, "broadcast", "DeployV2Core.s.sol", String(CHAIN_ID), "run-latest.json"),
    path.join(fiContracts, "broadcast", "Deploy0xFiV2.s.sol", String(CHAIN_ID), "run-latest.json"),
  ]) {
    const data = readJson(journal);
    const blockByHash = new Map(data.receipts.map((receipt) => [receipt.transactionHash, Number(BigInt(receipt.blockNumber))]));
    for (const transaction of data.transactions) {
      if (transaction.transactionType === "CREATE") {
        blocks[getAddress(transaction.contractAddress)] = blockByHash.get(transaction.hash);
      }
    }
  }
  return blocks;
}

async function publish() {
  const manifest = readJson(manifestPath);
  if (manifest.stage !== "seeded" && manifest.stage !== "active") throw new Error("Deploy v2 before publishing it");
  const blocks = manifest.blocks ?? contractBlocks();
  const blockOf = (address) => {
    const block = blocks[getAddress(address)];
    if (!Number.isSafeInteger(block)) throw new Error(`No creation block recorded for ${address}`);
    return block;
  };
  const { core, fi } = manifest;
  const deploymentBlock = String(blockOf(core.nusd));

  // Network config: v2 becomes the active set; v1 is kept verbatim for reference.
  const networkPath = path.join(fiRoot, "config", "liteforge-testnet.json");
  const network = readJson(networkPath);
  const legacyV1 = network.legacyV1 ?? {
    existingContracts: network.existingContracts,
    pumpGraduation: network.pumpGraduation,
    goldsky: network.goldsky,
    deployment: network.deployment,
  };
  const contracts = {
    ...Object.fromEntries(FI_KEYS.map((key) => [key, fi[key]])),
    wzkLTC: fi.wzkLTC,
    ltcOracle: fi.ltcOracle,
    btcOracle: fi.btcOracle,
    ethOracle: fi.ethOracle,
    treasury: core.treasury,
    feeSplitter: core.feeSplitter,
    rewardStaking: core.rewardStaking,
    surplusMintGovernor: core.surplusMintGovernor,
    nusdMarketplace: core.nusdMarketplace,
  };
  const updatedNetwork = {
    ...network,
    existingContracts: {
      nusd: core.nusd,
      pump: core.pump,
      pumpGraduationRouter: core.pumpGraduationRouter,
      pumpLiquidityLocker: core.pumpLiquidityLocker,
    },
    pumpGraduation: { minimumDelaySeconds: 3600 },
    goldsky: { network: "liteforge", subgraph: FI_SUBGRAPH, tag: null, endpoint: goldskyEndpoint(FI_SUBGRAPH) },
    deployment: {
      status: manifest.stage === "active" ? "v2-tokenomics-active" : "v2-tokenomics-pending-graduation",
      governanceMode: "direct-deployer-no-timelock",
      governance: manifest.deployer,
      guardian: manifest.deployer,
      coreOwnershipStatus: "direct-deployer-owner-no-pending",
      riskMode: "caps-pauses-oracles-no-nusd-health-guard",
      lendingImplementationStatus: CURRENT_LENDING_IMPLEMENTATION_STATUS,
      lendingImplementationMigrationRequired: false,
      deploymentBlock,
      finalizedAt: manifest.deployedAt,
      contracts,
    },
    legacyV1,
  };
  atomicWriteFile(networkPath, `${JSON.stringify(updatedNetwork, null, 2)}\n`);

  // 0xFi subgraph: no synth fee gauge factory in v2.
  const subgraphConfigPath = path.join(fiRoot, "subgraph", "subgraph.config.json");
  const subgraphConfig = readJson(subgraphConfigPath);
  delete subgraphConfig.synthFeeGaugeFactoryAddress;
  delete subgraphConfig.synthFeeGaugeFactoryStartBlock;
  Object.assign(subgraphConfig, {
    factoryAddress: fi.dexFactory,
    gaugeFactoryAddress: fi.gaugeFactory,
    nbtcVaultAddress: fi.nBTCVault,
    nethVaultAddress: fi.nETHVault,
    lendingPoolAddress: fi.lendingPool,
    nusdAddress: core.nusd,
    startBlock: Number(deploymentBlock),
    factoryStartBlock: blockOf(fi.dexFactory),
    gaugeFactoryStartBlock: blockOf(fi.gaugeFactory),
    nbtcVaultStartBlock: blockOf(fi.nBTCVault),
    nethVaultStartBlock: blockOf(fi.nETHVault),
    lendingPoolStartBlock: blockOf(fi.lendingPool),
    deploymentName: FI_SUBGRAPH.split("/")[0],
  });
  atomicWriteFile(subgraphConfigPath, `${JSON.stringify(subgraphConfig, null, 2)}\n`);

  // Web: the same generator v1 used, plus the tokenomics contracts and v2 indexers.
  const flat = {
    ...contracts,
    nusd: core.nusd,
    pump: core.pump,
    deploymentBlock,
    synthRiskActivationStatus: "active",
    synthRiskActionsEnabled: true,
    lendingImplementationStatus: CURRENT_LENDING_IMPLEMENTATION_STATUS,
    lendingImplementationMigrationRequired: false,
  };
  const generated = {
    ...publicTestnetConfiguration({ deployment: flat, network: updatedNetwork, goldskyEndpoint: goldskyEndpoint(FI_SUBGRAPH) }),
    treasury: core.treasury,
    feeSplitter: core.feeSplitter,
    rewardStaking: core.rewardStaking,
    surplusMintGovernor: core.surplusMintGovernor,
    nusdMarketplace: core.nusdMarketplace,
    nusdMarketplaceDeploymentBlock: String(blockOf(core.nusdMarketplace)),
    pumpGraduationRouter: core.pumpGraduationRouter,
    pumpGoldskyEndpoint: goldskyEndpoint(PUMP_SUBGRAPH),
    nusdMarketGoldskyEndpoint: goldskyEndpoint(NUSD_MARKET_SUBGRAPH),
  };
  atomicWriteFile(publicGeneratedConfigTarget(fiRoot), `${JSON.stringify(generated, null, 2)}\n`);

  writeManifest({ ...manifest, blocks, published: { fiSubgraph: FI_SUBGRAPH, pumpSubgraph: PUMP_SUBGRAPH, nusdMarketSubgraph: NUSD_MARKET_SUBGRAPH } });
  console.log(JSON.stringify({ published: true, deploymentBlock, web: publicGeneratedConfigTarget(fiRoot) }, null, 2));
}

async function status() {
  if (!fs.existsSync(manifestPath)) {
    console.log(JSON.stringify({ stage: "none" }));
    return;
  }
  const manifest = readJson(manifestPath);
  const ctx = clientsFor(primaryRpcUrl(network));
  const c = { ...manifest.core, ...manifest.fi };
  const extra = {};
  if (c.nusd) {
    extra.nusdSupply = formatEther(await read(ctx, c.nusd, nusdAbi, "totalSupply"));
    extra.reserveValueNusd = formatEther(await read(ctx, c.nusd, nusdAbi, "reserveValueNusd"));
    extra.rewardPoolAvailable = formatEther(await read(ctx, c.rewardStaking, stakingAbi, "availableRewards"));
  }
  console.log(JSON.stringify({ stage: manifest.stage, graduationReadyAt: manifest.graduationReadyAt, ...extra }, null, 2));
}

if (mode === "--rehearse") await rehearse();
else if (mode === "--broadcast") await broadcastLive();
else if (mode === "--activate") await activateLive();
else if (mode === "--publish") await publish();
else await status();
