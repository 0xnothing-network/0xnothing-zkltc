import assert from "node:assert/strict";
import test from "node:test";
import type * as LiveData from "../../lib/liveData.ts";
import { evaluateModule } from "../helpers/evaluateModule.ts";

const live = evaluateModule<typeof LiveData>(new URL("../../lib/liveData.ts", import.meta.url), {});
const read = (functionName: string) => ["readContract", { address: "0x0000000000000000000000000000000000000001", functionName }];

test("every contract read is live state unless it is a constant or fixed metadata", () => {
  for (const functionName of ["accountState", "queuedRewards", "earned", "surplusMintCapacity", "balanceOf", "owner", "oracle"]) {
    assert.equal(live.isBlockSyncedQueryKey(read(functionName)), true, functionName);
  }
  for (const functionName of ["symbol", "decimals", "name", "token0", "tokenPackedData", "STREAM_DURATION", "BURN_BPS", "IMPLEMENTATION_ID"]) {
    assert.equal(live.isBlockSyncedQueryKey(read(functionName)), false, functionName);
  }
});

test("a batch is live when any of its reads is", () => {
  assert.equal(live.isBlockSyncedQueryKey(["readContracts", { contracts: [{ functionName: "symbol" }, { functionName: "rewardRate" }] }]), true);
  assert.equal(live.isBlockSyncedQueryKey(["readContracts", { contracts: [{ functionName: "symbol" }, { functionName: "decimals" }] }]), false);
  assert.equal(live.isBlockSyncedQueryKey(["balance", { address: "0x0000000000000000000000000000000000000002" }]), true);
});

test("chain events also refresh indexer-backed app queries, but not fixed artwork or metadata", () => {
  for (const key of [["pump-trades", "0x1"], ["pixel-nusd-market"], ["fi-pools"], ["fi-activity", "0x2"], ["rwa-state"]]) {
    assert.equal(live.isLiveQueryKey(key), true, String(key[0]));
    assert.equal(live.isBlockSyncedQueryKey(key), false, String(key[0]));
  }
  for (const key of [["pump-token-metadata", "0x1"], ["pixel-nusd-artwork", "1"], ["connectorClient"], ["waitForTransactionReceipt"]]) {
    assert.equal(live.isLiveQueryKey(key), false, String(key[0]));
  }
});

test("polling stretches only while the event socket is connected", () => {
  assert.equal(live.livePollInterval(5_000, 3), 5_000);
  live.setLiveSocketConnected(true);
  assert.equal(live.isLiveSocketConnected(), true);
  assert.equal(live.livePollInterval(5_000, 3), 15_000);
  live.setLiveSocketConnected(false);
  assert.equal(live.livePollInterval(5_000, 3), 5_000);
});

test("loaders outside React Query hear every refresh wave until they unsubscribe", () => {
  let heard = 0;
  const unsubscribe = live.subscribeLiveWaves(() => { heard += 1; });
  live.notifyLiveWave();
  live.notifyLiveWave();
  unsubscribe();
  live.notifyLiveWave();
  assert.equal(heard, 2);
});
