import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

class GraphInt {
  constructor(value) { this.value = BigInt(value); }
  plus(other) { return new GraphInt(this.value + other.value); }
}

const integer = (value) => new GraphInt(value);
const address = '0x0000000000000000000000000000000000000011';

function setup() {
  const stored = new Map([[address, {
    id: address, totalFunded: integer(200), rewardRate: integer(1),
    periodFinish: integer(1_000), updatedAt: integer(0),
  }]]);
  class Gauge {
    constructor(id) { this.id = id; }
    static load(id) { return stored.has(id) ? Object.assign(new Gauge(id), stored.get(id)) : null; }
    save() { stored.set(this.id, { ...this }); }
  }
  const source = fs.readFileSync(new URL('../src/gauge.ts', import.meta.url), 'utf8');
  const executable = stripTypeScriptTypes(source)
    .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/^export /gm, '');
  const context = { Gauge, Address: { zero: () => address }, ZERO_BI: integer(0) };
  vm.createContext(context);
  vm.runInContext(executable, context, { timeout: 1_000 });
  return { context, stored };
}

test('gauge reward schedule: final withdrawal pauses the reported finish at the event timestamp', () => {
  const fixture = setup();
  fixture.context.handleRewardSchedulePaused({ address, params: { remainingDuration: integer(800) }, block: { timestamp: integer(200) } });
  const gauge = fixture.stored.get(address);
  assert.equal(gauge.periodFinish.value, 200n);
  assert.equal(gauge.updatedAt.value, 200n);
  assert.equal(gauge.totalFunded.value, 200n);
});

test('gauge reward schedule: first new stake restores the emitted finish without changing funding', () => {
  const fixture = setup();
  fixture.context.handleRewardScheduleResumed({ address, params: { periodFinish: integer(1_100) }, block: { timestamp: integer(300) } });
  const gauge = fixture.stored.get(address);
  assert.equal(gauge.periodFinish.value, 1_100n);
  assert.equal(gauge.updatedAt.value, 300n);
  assert.equal(gauge.totalFunded.value, 200n);
});

test('gauge reward schedule: ABI contains both emitted schedule transitions', () => {
  const abi = JSON.parse(fs.readFileSync(new URL('../abis/LiquidityGauge.json', import.meta.url), 'utf8'));
  for (const [name, argument] of [['RewardSchedulePaused', 'remainingDuration'], ['RewardScheduleResumed', 'periodFinish']]) {
    const entry = abi.find((item) => item.type === 'event' && item.name === name);
    assert.ok(entry, name);
    assert.equal(entry.inputs[0].name, argument);
    assert.equal(entry.inputs[0].type, 'uint256');
    assert.equal(entry.inputs[0].indexed, false);
  }
});

test('gauge reward schedule: source manifest wires both handlers for dynamically created gauges', () => {
  const manifest = fs.readFileSync(new URL('../subgraph.template.yaml', import.meta.url), 'utf8');
  for (const name of ['RewardSchedulePaused', 'RewardScheduleResumed']) {
    assert.match(manifest, new RegExp(`event: ${name}\\(uint256\\)\\s+handler: handle${name}`));
  }
});
