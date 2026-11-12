import assert from "node:assert/strict";
import { test } from "node:test";
import { logRanges, MAX_LOG_RANGE_BLOCKS } from "../../lib/logRanges.ts";

const spans = (from: bigint, to: bigint, size?: bigint) =>
  logRanges(from, to, size).map((range) => `${range.fromBlock}-${range.toBlock}`);

test("a log scan is split into windows the RPC accepts, with no gap or overlap", () => {
  assert.equal(MAX_LOG_RANGE_BLOCKS, 2_000n);
  assert.deepEqual(spans(10n, 10n), ["10-10"]);
  assert.deepEqual(spans(1n, 2_000n), ["1-2000"]);
  assert.deepEqual(spans(1n, 2_001n), ["1-1", "2-2001"]);
  // Windows are aligned to the newest block, so the short one is the oldest.
  assert.deepEqual(spans(0n, 9n, 4n), ["0-1", "2-5", "6-9"]);
  assert.deepEqual(spans(11n, 10n), []);

  const ranges = logRanges(61_141_359n, 61_151_358n);
  assert.equal(ranges.length, 5);
  assert.ok(ranges.every((range) => range.toBlock - range.fromBlock + 1n <= MAX_LOG_RANGE_BLOCKS));
  for (let index = 1; index < ranges.length; index++) {
    assert.equal(ranges[index].fromBlock, ranges[index - 1].toBlock + 1n);
  }
  assert.throws(() => logRanges(0n, 1n, 0n), RangeError);
});
