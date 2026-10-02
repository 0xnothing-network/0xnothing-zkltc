import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

class GraphInt {
  constructor(value) { this.value = BigInt(value); }
  plus(other) { return new GraphInt(this.value + other.value); }
  toString() { return this.value.toString(); }
}

const integer = (value) => new GraphInt(value);
const address = '0x0000000000000000000000000000000000000011';
const configurations = [
  {
    file: 'lending.ts', entity: 'LendingMarket', binding: 'LendingPool',
    governance: {
      supplyCapNusd: integer(1_000), borrowCapNusd: integer(800),
      supplyPaused: false, borrowPaused: false, collateralWithdrawalPaused: false,
    },
    accounting: {
      totalSupplied: integer(200), totalBorrowed: integer(100),
      totalBadDebtNusd: integer(0), borrowIndexWad: integer(1),
    },
  },
  {
    file: 'syntheticVault.ts', entity: 'SyntheticMarket', binding: 'SyntheticVault',
    governance: { debtCeilingSynthetic: integer(1_000), mintPaused: false, withdrawPaused: false },
    accounting: {
      syntheticAsset: address, safetyReserve: address,
      totalCollateralNusd: integer(300), totalUserCollateralNusd: integer(200),
      totalReserveCollateralNusd: integer(100), totalDebtSynthetic: integer(100), totalBadDebtSynthetic: integer(0),
    },
  },
];

function setup(config) {
  const stored = new Map();
  const values = { ...config.accounting, ...config.governance };
  const failures = new Set();
  const reads = new Map();
  const contract = {};
  for (const field of Object.keys(values)) {
    contract[`try_${field}`] = () => {
      reads.set(field, (reads.get(field) ?? 0) + 1);
      return failures.has(field) ? { reverted: true } : { reverted: false, value: values[field] };
    };
  }
  class Market {
    constructor(id) { this.id = id; }
    static load(id) { return stored.has(id) ? Object.assign(new Market(id), stored.get(id)) : null; }
    save() { stored.set(this.id, { ...this }); }
  }
  const context = {
    Address: { fromString: (value) => value, zero: () => '0x0000000000000000000000000000000000000000' },
    BigInt: GraphInt, ZERO_BI: integer(0),
    ERC20: { bind: () => ({ try_symbol: () => ({ reverted: false, value: 'SYNTH' }) }) },
    [config.entity]: Market, [config.binding]: { bind: () => contract },
  };
  const source = fs.readFileSync(new URL(`../src/${config.file}`, import.meta.url), 'utf8');
  const executable = stripTypeScriptTypes(source)
    .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/^export /gm, '');
  vm.createContext(context);
  vm.runInContext(executable, context, { timeout: 1_000 });
  return { values, failures, reads, stored, refresh: (governance = false) => context.refreshMarket(address, integer(100), governance) };
}

function assertGovernance(market, values, fields) {
  for (const field of fields) {
    const actual = market[field];
    const expected = values[field];
    if (expected instanceof GraphInt) assert.equal(actual.value, expected.value, field);
    else assert.equal(actual, expected, field);
  }
}

for (const config of configurations) {
  const fields = Object.keys(config.governance);
  for (const failedField of fields) {
    test(`${config.entity}: retries an incomplete initialization when ${failedField} reverted`, () => {
      const fixture = setup(config);
      fixture.failures.add(failedField);
      fixture.refresh();
      fixture.failures.clear();
      fixture.refresh();
      assertGovernance(fixture.stored.get(address), fixture.values, fields);
      assert.equal(fixture.reads.get(failedField), 2);
    });

    test(`${config.entity}: retries an incomplete governance event when ${failedField} reverted`, () => {
      const fixture = setup(config);
      fixture.refresh();
      fixture.values[failedField] = typeof fixture.values[failedField] === 'boolean' ? true : integer(2_000);
      fixture.failures.add(failedField);
      fixture.refresh(true);
      fixture.failures.clear();
      fixture.refresh();
      assertGovernance(fixture.stored.get(address), fixture.values, fields);
      assert.equal(fixture.reads.get(failedField), 3);
    });
  }

  test(`${config.entity}: reuses a fully read paused configuration without repeated governance RPCs`, () => {
    const fixture = setup(config);
    for (const field of fields) if (typeof fixture.values[field] === 'boolean') fixture.values[field] = true;
    fixture.refresh();
    fixture.refresh();
    assertGovernance(fixture.stored.get(address), fixture.values, fields);
    for (const field of fields) assert.equal(fixture.reads.get(field), 1, field);
  });
}
