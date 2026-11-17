import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const source = (file) => read(`../src/${file}`);
const subgraphConfig = JSON.parse(read('../subgraph.config.json'));
const contracts = JSON.parse(read('../../config/liteforge-testnet.json')).deployment.contracts;
const deployScript = read('../../contracts/script/Deploy0xFiV3.s.sol');

const literal = (file, name) => {
  const match = source(file).match(new RegExp(`const ${name} = \\w+\\.from(?:String)?\\("([^"]+)"\\)`));
  assert.ok(match, `${name} in ${file}`);
  return match[1].toLowerCase();
};
const ether = (name) => {
  const match = deployScript.match(new RegExp(`${name} = ([\\d.]+) ether;`));
  assert.ok(match, name);
  const [whole, fraction = ''] = match[1].split('.');
  return (BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'))).toString();
};

test('hard-coded deployment facts match the deployment config and the v3 deploy script', () => {
  assert.equal(literal('helpers.ts', 'NUSD'), subgraphConfig.nusdAddress.toLowerCase());
  assert.equal(literal('helpers.ts', 'WZKLTC'), contracts.wzkLTC.toLowerCase());
  assert.equal(literal('helpers.ts', 'NBTC'), contracts.nBTC.toLowerCase());
  assert.equal(literal('helpers.ts', 'NETH'), contracts.nETH.toLowerCase());
  assert.equal(literal('syntheticVault.ts', 'NBTC_VAULT'), subgraphConfig.nbtcVaultAddress.toLowerCase());
  assert.equal(literal('syntheticVault.ts', 'NETH_VAULT'), subgraphConfig.nethVaultAddress.toLowerCase());
  assert.equal(literal('syntheticVault.ts', 'NBTC_VAULT'), contracts.nBTCVault.toLowerCase());
  assert.equal(literal('syntheticVault.ts', 'NETH_VAULT'), contracts.nETHVault.toLowerCase());
  assert.equal(literal('syntheticVault.ts', 'SAFETY_RESERVE'), contracts.synthSafetyReserve.toLowerCase());
  assert.equal(literal('syntheticVault.ts', 'NBTC_DEBT_CEILING'), ether('NBTC_DEBT_CEILING'));
  assert.equal(literal('syntheticVault.ts', 'NETH_DEBT_CEILING'), ether('NETH_DEBT_CEILING'));
  assert.equal(subgraphConfig.lendingPoolAddress.toLowerCase(), contracts.lendingPool.toLowerCase());
  assert.equal(literal('lending.ts', 'SUPPLY_CAP'), ether('LENDING_SUPPLY_CAP'));
  assert.equal(literal('lending.ts', 'BORROW_CAP'), ether('LENDING_BORROW_CAP'));
  assert.match(deployScript, /new PooledNUSDLendingPoolV2\([^)]*LENDING_BORROW_CAP, true\s*\)/);
});

test('no mapping makes an eth_call', () => {
  for (const file of fs.readdirSync(new URL('../src/', import.meta.url))) {
    assert.doesNotMatch(source(file), /\.bind\(|\.try_\w+\(/, file);
  }
});

class GraphInt {
  constructor(value) { this.value = BigInt(value); }
  static fromString(value) { return new GraphInt(value); }
  plus(other) { return new GraphInt(this.value + other.value); }
  minus(other) { return new GraphInt(this.value - other.value); }
}

test('synthetic totals follow a liquidation that eats user and reserve collateral', () => {
  const stored = new Map();
  class Entity {
    constructor(id) { this.id = id; }
    static load(id) { const key = id.value ?? id; return stored.has(key) ? Object.assign(new this(id), stored.get(key)) : null; }
    save() { stored.set(this.id.value ?? this.id, { ...this }); }
  }
  const vault = '0x094343b925941d00424e8440c572231d6b93a751';
  const address = (value) => ({ value, equals: (other) => value === (other.value ?? other) });
  const context = {
    Address: { fromString: address, zero: () => address('0x0') },
    BigInt: GraphInt,
    SyntheticMarket: class extends Entity {},
    SyntheticAction: class extends Entity {},
    eventId: (hash, index) => `${hash}-${index}`,
    NBTC: address('nbtc'), NETH: address('neth'), ZERO_BI: new GraphInt(0),
  };
  const executable = stripTypeScriptTypes(source('syntheticVault.ts'))
    .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/^export /gm, '');
  vm.createContext(context);
  vm.runInContext(executable, context, { timeout: 1_000 });

  let logIndex = 0;
  const emit = (handler, params) => context[handler]({
    address: address(vault),
    params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'number' ? new GraphInt(v) : v])),
    transaction: { hash: '0xabc', from: address('0x1') },
    block: { timestamp: new GraphInt(1), number: new GraphInt(1) },
    logIndex: logIndex++,
  });
  const who = address('0x2');
  emit('handleCollateralDeposited', { payer: who, account: who, amountNusd: 100 });
  emit('handleReserveCollateralAllocated', { account: who, amountNusd: 50 });
  emit('handleSyntheticMinted', { account: who, recipient: who, amountSynthetic: 10, debtAfter: 10 });
  // Same order as SyntheticVault.liquidate: reserve loss, bad debt, then the liquidation itself.
  emit('handleReserveCollateralLost', { account: who, amountNusd: 20 });
  emit('handleBadDebtRecognized', { account: who, amountSynthetic: 3 });
  emit('handlePositionLiquidated', { liquidator: who, account: who, recipient: who, repaidSynthetic: 7, seizedNusd: 120 });
  emit('handleBadDebtCovered', { payer: who, account: who, amountSynthetic: 1 });
  emit('handleMintPauseUpdated', { paused: true });

  const market = stored.get(vault);
  assert.equal(market.totalUserCollateralNusd.value, 0n);
  assert.equal(market.totalReserveCollateralNusd.value, 30n);
  assert.equal(market.totalCollateralNusd.value, 30n);
  assert.equal(market.totalDebtSynthetic.value, 0n);
  assert.equal(market.totalBadDebtSynthetic.value, 2n);
  assert.equal(market.debtCeilingSynthetic.value, 10n ** 16n);
  assert.equal(market.symbol, 'nBTC');
  assert.equal(market.mintPaused, true);
  assert.equal(market.withdrawPaused, false);
});
