#!/usr/bin/env node

import process from "node:process";

import { parseAbi } from "viem";

import {
  loadRuntime,
  requiredAddress,
  sendContract,
} from "./lib/graduation-runtime.mjs";

const broadcast = process.argv.includes("--broadcast");
if (process.argv.some((argument) => argument.startsWith("--") && argument !== "--broadcast")) {
  throw new Error("Use no flag for a read-only check or --broadcast to seed testnet liquidity");
}

const runtime = loadRuntime({ wallet: broadcast });
const { deployment, network, publicClient, walletClient, account } = runtime;
const chainId = await publicClient.getChainId();
if (chainId !== 4441 || chainId !== Number(network.chainId) || chainId !== Number(deployment.chainId)) {
  throw new Error(`Wrong chain: expected 4441, received ${chainId}`);
}

const owner = requiredAddress(deployment.deployer, "deployment owner");
if (account && account.address.toLowerCase() !== owner.toLowerCase()) {
  throw new Error(`Configured wallet ${account.address} is not deployment owner ${owner}`);
}

const addresses = {
  nusd: requiredAddress(deployment.nusd, "NUSD"),
  router: requiredAddress(deployment.dexRouter, "DEX router"),
  legacyNbtcVault: requiredAddress(
    deployment.synthSafetyReserveMigration?.previousNBTCVault,
    "legacy nBTC vault",
  ),
  synthGaugeFactory: requiredAddress(deployment.synthFeeGaugeFactory, "synth gauge factory"),
  ltcOracle: requiredAddress(deployment.ltcOracle, "LTC oracle"),
  btcOracle: requiredAddress(deployment.btcOracle, "BTC oracle"),
  ethOracle: requiredAddress(deployment.ethOracle, "ETH oracle"),
  corePair: requiredAddress(deployment.wzkLtcNusdPair, "WzkLTC/NUSD pair"),
  coreGauge: requiredAddress(deployment.wzkLtcNusdGauge, "WzkLTC/NUSD gauge"),
  nbtc: requiredAddress(deployment.nBTC, "nBTC"),
  nbtcVault: requiredAddress(deployment.nBTCVault, "nBTC vault"),
  nbtcPair: requiredAddress(deployment.nBTCNusdPair, "nBTC/NUSD pair"),
  nbtcGauge: requiredAddress(deployment.nBTCNusdGauge, "nBTC/NUSD gauge"),
  neth: requiredAddress(deployment.nETH, "nETH"),
  nethVault: requiredAddress(deployment.nETHVault, "nETH vault"),
  nethPair: requiredAddress(deployment.nETHNusdPair, "nETH/NUSD pair"),
  nethGauge: requiredAddress(deployment.nETHNusdGauge, "nETH/NUSD gauge"),
};

const CORE_NUSD = 2n * 10n ** 18n;
const SYNTH_COLLATERAL_NUSD = 15n * 10n ** 17n;
const LEGACY_OWNER_COLLATERAL_NUSD = 8n * 10n ** 18n;
const WAD = 10n ** 18n;

const erc20Abi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const legacyVaultAbi = parseAbi([
  "function positions(address) view returns (uint256 collateralNusd,uint256 debtSynthetic)",
  "function mintPaused() view returns (bool)",
  "function withdrawPaused() view returns (bool)",
  "function withdrawCollateral(uint256 amountNusd,address recipient)",
]);
const oracleAbi = parseAbi([
  "function isFresh() view returns (bool)",
  "function readPriceWad() view returns (uint256 priceWad,uint256 updatedAt,uint80 roundId)",
]);
const pairAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)",
]);
const gaugeAbi = parseAbi([
  "function depositsPaused() view returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function rewardRate() view returns (uint256)",
  "function stake(uint256 amount)",
]);
const vaultAbi = parseAbi([
  "function activated() view returns (bool)",
  "function mintPaused() view returns (bool)",
  "function positions(address) view returns (uint256 userCollateralNusd,uint256 reserveCollateralNusd,uint256 debtSynthetic)",
  "function quoteDepositAndMint(address,uint256) view returns (uint256 syntheticAmount,uint256 reserveRequiredNusd,bool oneToOneAvailable)",
  "function quoteMintFee(uint256) view returns (uint256 feeNusd)",
  "function depositAndMint(uint256 collateralAmountNusd,uint256 syntheticAmount,uint256 maximumFeeNusd,address recipient)",
]);
const routerAbi = parseAbi([
  "function addLiquidity((address tokenA,address tokenB,uint256 amountADesired,uint256 amountBDesired,uint256 amountAMin,uint256 amountBMin,uint256 minimumLiquidity,address to,uint256 deadline) params) returns (uint256 amountA,uint256 amountB,uint256 liquidity)",
  "function addLiquidityNative((address token,uint256 amountTokenDesired,uint256 amountTokenMin,uint256 amountNativeMin,uint256 minimumLiquidity,address to,uint256 deadline) params) payable returns (uint256 amountToken,uint256 amountNative,uint256 liquidity)",
]);
const gaugeFactoryAbi = parseAbi([
  "function pendingMintFeesNusd(address) view returns (uint256)",
  "function flushMintFees(address) returns (uint256 amountFlushedNusd)",
]);

const synthMarkets = [
  {
    symbol: "nBTC",
    asset: addresses.nbtc,
    vault: addresses.nbtcVault,
    pair: addresses.nbtcPair,
    gauge: addresses.nbtcGauge,
    oracle: addresses.btcOracle,
  },
  {
    symbol: "nETH",
    asset: addresses.neth,
    vault: addresses.nethVault,
    pair: addresses.nethPair,
    gauge: addresses.nethGauge,
    oracle: addresses.ethOracle,
  },
];

const sent = [];
const read = (address, abi, functionName, args = []) => publicClient.readContract({
  address,
  abi,
  functionName,
  args,
});

async function send(address, abi, functionName, args = [], options = {}) {
  if (!broadcast) throw new Error("A state-changing action was reached during read-only mode");
  let result;
  if (options.value !== undefined) {
    const simulation = await publicClient.simulateContract({
      account,
      address,
      abi,
      functionName,
      args,
      value: options.value,
    });
    const hash = await walletClient.writeContract(simulation.request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
    result = { hash, receipt };
  } else {
    result = await sendContract(runtime, address, abi, functionName, args);
  }
  sent.push({ functionName, transactionHash: result.hash, block: result.receipt.blockNumber });
  return result;
}

async function approveExact(token, spender, amount) {
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
  if (!fresh || snapshot[0] === 0n || snapshot[1] === 0n || snapshot[2] === 0n) {
    throw new Error(`${label} oracle is not fresh`);
  }
  return snapshot[0];
}

async function pairState(pair, gauge) {
  const [supply, reserves, ownerLp, gaugeStake, ownerStake, depositsPaused] = await Promise.all([
    read(pair, pairAbi, "totalSupply"),
    read(pair, pairAbi, "getReserves"),
    read(pair, pairAbi, "balanceOf", [owner]),
    read(gauge, gaugeAbi, "totalSupply"),
    read(gauge, gaugeAbi, "balanceOf", [owner]),
    read(gauge, gaugeAbi, "depositsPaused"),
  ]);
  const liquid = supply !== 0n || reserves[0] !== 0n || reserves[1] !== 0n;
  if (liquid && (supply === 0n || reserves[0] === 0n || reserves[1] === 0n)) {
    throw new Error(`Pair ${pair} has inconsistent liquidity accounting`);
  }
  if (depositsPaused) throw new Error(`Gauge ${gauge} has deposits paused`);
  if (gaugeStake !== ownerStake) throw new Error(`Gauge ${gauge} contains non-owner stake`);
  return { supply, reserves, ownerLp, gaugeStake, ownerStake, liquid };
}

async function stakeOwnerLiquidity(pair, gauge) {
  const state = await pairState(pair, gauge);
  if (state.gaugeStake !== 0n) {
    if (state.ownerLp !== 0n) throw new Error(`Pair ${pair} has unaccounted owner LP`);
    return;
  }
  if (!state.liquid || state.ownerLp === 0n) throw new Error(`Pair ${pair} is not ready to stake`);
  await approveExact(pair, gauge, state.ownerLp);
  await send(gauge, gaugeAbi, "stake", [state.ownerLp]);
}

async function recoverLegacyCollateral() {
  const [position, mintPaused, withdrawPaused, walletNusd] = await Promise.all([
    read(addresses.legacyNbtcVault, legacyVaultAbi, "positions", [owner]),
    read(addresses.legacyNbtcVault, legacyVaultAbi, "mintPaused"),
    read(addresses.legacyNbtcVault, legacyVaultAbi, "withdrawPaused"),
    read(addresses.nusd, erc20Abi, "balanceOf", [owner]),
  ]);
  if (!mintPaused || withdrawPaused || position[1] !== 0n) {
    throw new Error("Legacy owner position is not debt-free and safely withdrawable");
  }
  if (position[0] === 0n) return walletNusd;
  if (position[0] !== LEGACY_OWNER_COLLATERAL_NUSD || walletNusd !== 0n) {
    throw new Error("Legacy collateral recovery state is unexpected");
  }
  if (!broadcast) return walletNusd + position[0];
  await send(addresses.legacyNbtcVault, legacyVaultAbi, "withdrawCollateral", [position[0], owner]);
  return read(addresses.nusd, erc20Abi, "balanceOf", [owner]);
}

async function bootstrapCorePool() {
  const state = await pairState(addresses.corePair, addresses.coreGauge);
  if (!state.liquid) {
    if (state.ownerLp !== 0n || state.gaugeStake !== 0n) throw new Error("Core pool has partial bootstrap state");
    if (!broadcast) return;
    const ltcPrice = await freshPrice(addresses.ltcOracle, "LTC");
    const nativeAmount = CORE_NUSD * WAD / ltcPrice;
    if (nativeAmount === 0n) throw new Error("Native bootstrap amount rounded to zero");
    const nusdBalance = await read(addresses.nusd, erc20Abi, "balanceOf", [owner]);
    if (nusdBalance < CORE_NUSD) throw new Error("Not enough NUSD for the core pool bootstrap");
    await approveExact(addresses.nusd, addresses.router, CORE_NUSD);
    const block = await publicClient.getBlock();
    await send(addresses.router, routerAbi, "addLiquidityNative", [{
      token: addresses.nusd,
      amountTokenDesired: CORE_NUSD,
      amountTokenMin: CORE_NUSD,
      amountNativeMin: nativeAmount,
      minimumLiquidity: 1n,
      to: owner,
      deadline: block.timestamp + 3600n,
    }], { value: nativeAmount });
  }
  if (broadcast) await stakeOwnerLiquidity(addresses.corePair, addresses.coreGauge);
}

async function bootstrapSynthMarket(market) {
  let state = await pairState(market.pair, market.gauge);
  let [position, assetSupply, assetBalance, activated, mintPaused] = await Promise.all([
    read(market.vault, vaultAbi, "positions", [owner]),
    read(market.asset, erc20Abi, "totalSupply"),
    read(market.asset, erc20Abi, "balanceOf", [owner]),
    read(market.vault, vaultAbi, "activated"),
    read(market.vault, vaultAbi, "mintPaused"),
  ]);
  if (!activated || mintPaused) throw new Error(`${market.symbol} vault is not active`);

  if (!state.liquid && position[2] === 0n) {
    if (position[0] !== 0n || position[1] !== 0n || assetSupply !== 0n || assetBalance !== 0n) {
      throw new Error(`${market.symbol} has a non-prefix bootstrap state`);
    }
    const quote = await read(market.vault, vaultAbi, "quoteDepositAndMint", [owner, SYNTH_COLLATERAL_NUSD]);
    if (quote[0] === 0n || quote[1] !== 0n || quote[2]) {
      throw new Error(`${market.symbol} did not quote the reviewed 150% fallback mode`);
    }
    const mintFee = await read(market.vault, vaultAbi, "quoteMintFee", [quote[0]]);
    if (mintFee === 0n) throw new Error(`${market.symbol} mint fee rounded to zero`);
    if (!broadcast) return;
    const nusdBalance = await read(addresses.nusd, erc20Abi, "balanceOf", [owner]);
    const debit = SYNTH_COLLATERAL_NUSD + mintFee;
    if (nusdBalance < debit) throw new Error(`Not enough NUSD to mint ${market.symbol}`);
    await approveExact(addresses.nusd, market.vault, debit);
    await send(market.vault, vaultAbi, "depositAndMint", [
      SYNTH_COLLATERAL_NUSD,
      quote[0],
      mintFee,
      owner,
    ]);
    [position, assetSupply, assetBalance] = await Promise.all([
      read(market.vault, vaultAbi, "positions", [owner]),
      read(market.asset, erc20Abi, "totalSupply"),
      read(market.asset, erc20Abi, "balanceOf", [owner]),
    ]);
  }

  if (!state.liquid) {
    if (position[0] !== SYNTH_COLLATERAL_NUSD || position[1] !== 0n || position[2] === 0n) {
      throw new Error(`${market.symbol} minted position is not bootstrap-safe`);
    }
    if (assetBalance !== position[2] || assetSupply !== position[2]) {
      throw new Error(`${market.symbol} supply is not fully owned for bootstrap`);
    }
    if (!broadcast) return;
    const price = await freshPrice(market.oracle, market.symbol);
    const quoteNusd = assetBalance * price / WAD;
    if (quoteNusd === 0n) throw new Error(`${market.symbol} NUSD quote rounded to zero`);
    const nusdBalance = await read(addresses.nusd, erc20Abi, "balanceOf", [owner]);
    if (nusdBalance < quoteNusd) throw new Error(`Not enough NUSD to seed ${market.symbol}`);
    await approveExact(market.asset, addresses.router, assetBalance);
    await approveExact(addresses.nusd, addresses.router, quoteNusd);
    const block = await publicClient.getBlock();
    await send(addresses.router, routerAbi, "addLiquidity", [{
      tokenA: market.asset,
      tokenB: addresses.nusd,
      amountADesired: assetBalance,
      amountBDesired: quoteNusd,
      amountAMin: assetBalance,
      amountBMin: quoteNusd,
      minimumLiquidity: 1n,
      to: owner,
      deadline: block.timestamp + 3600n,
    }]);
    state = await pairState(market.pair, market.gauge);
  }

  if (broadcast && state.gaugeStake === 0n) await stakeOwnerLiquidity(market.pair, market.gauge);
  const [pending, gaugeStake] = await Promise.all([
    read(addresses.synthGaugeFactory, gaugeFactoryAbi, "pendingMintFeesNusd", [market.pair]),
    read(market.gauge, gaugeAbi, "totalSupply"),
  ]);
  if (broadcast && pending !== 0n && gaugeStake !== 0n) {
    await send(addresses.synthGaugeFactory, gaugeFactoryAbi, "flushMintFees", [market.pair]);
  }
}

async function snapshot() {
  const [walletNusd, legacyPosition, core, synth] = await Promise.all([
    read(addresses.nusd, erc20Abi, "balanceOf", [owner]),
    read(addresses.legacyNbtcVault, legacyVaultAbi, "positions", [owner]),
    pairState(addresses.corePair, addresses.coreGauge),
    Promise.all(synthMarkets.map(async (market) => {
      const [pair, position, pending, rewardRate] = await Promise.all([
        pairState(market.pair, market.gauge),
        read(market.vault, vaultAbi, "positions", [owner]),
        read(addresses.synthGaugeFactory, gaugeFactoryAbi, "pendingMintFeesNusd", [market.pair]),
        read(market.gauge, gaugeAbi, "rewardRate"),
      ]);
      return { symbol: market.symbol, pair, position, pending, rewardRate };
    })),
  ]);
  return { walletNusd, legacyPosition, core, synth };
}

const before = await snapshot();
if (!broadcast) {
  await freshPrice(addresses.ltcOracle, "LTC");
  await freshPrice(addresses.btcOracle, "BTC");
  await freshPrice(addresses.ethOracle, "ETH");
  const alreadyComplete = before.core.liquid
    && before.core.gaugeStake !== 0n
    && before.synth.every((market) => market.pair.liquid && market.pair.gaugeStake !== 0n);
  console.log(JSON.stringify({
    mode: "check",
    chainId,
    alreadyComplete,
    legacyOwnerCollateralNusd: before.legacyPosition[0],
    walletNusd: before.walletNusd,
    core: { liquid: before.core.liquid, staked: before.core.gaugeStake },
    synth: before.synth.map((market) => ({
      symbol: market.symbol,
      liquid: market.pair.liquid,
      staked: market.pair.gaugeStake,
      userCollateralNusd: market.position[0],
      debtSynthetic: market.position[2],
      pendingRewardsNusd: market.pending,
      rewardRate: market.rewardRate,
    })),
    readyToBootstrap: !alreadyComplete,
  }, (key, value) => typeof value === "bigint" ? value.toString() : value, 2));
  process.exit();
}

await recoverLegacyCollateral();
await bootstrapCorePool();
for (const market of synthMarkets) await bootstrapSynthMarket(market);

const after = await snapshot();
if (
  after.legacyPosition[0] !== 0n
    || after.legacyPosition[1] !== 0n
    || !after.core.liquid
    || after.core.gaugeStake === 0n
    || after.core.ownerLp !== 0n
    || after.synth.some((market) => (
      !market.pair.liquid
        || market.pair.gaugeStake === 0n
        || market.pair.ownerLp !== 0n
        || market.position[0] !== SYNTH_COLLATERAL_NUSD
        || market.position[1] !== 0n
        || market.position[2] === 0n
        || market.pending !== 0n
        || market.rewardRate === 0n
    ))
) throw new Error("Canonical liquidity bootstrap post-state verification failed");

console.log(JSON.stringify({
  mode: "broadcast",
  chainId,
  walletNusdRemaining: after.walletNusd,
  coreLpStaked: after.core.gaugeStake,
  synth: after.synth.map((market) => ({
    symbol: market.symbol,
    userCollateralNusd: market.position[0],
    debtSynthetic: market.position[2],
    lpStaked: market.pair.gaugeStake,
    rewardRate: market.rewardRate,
  })),
  transactions: sent,
}, (key, value) => typeof value === "bigint" ? value.toString() : value, 2));
