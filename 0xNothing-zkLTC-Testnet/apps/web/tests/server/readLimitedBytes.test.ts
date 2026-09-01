import assert from "node:assert/strict";
import test from "node:test";
import { readLimitedBytes } from "../../lib/server/readLimitedBytes.ts";

function byteStream(...chunks: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
      controller.close();
    },
  });
}

test("readLimitedBytes preserves chunk order and accepts the exact limit", async () => {
  const result = await readLimitedBytes(byteStream([1, 2], [3, 4]), 4, () => new Error("large"));
  assert.deepEqual([...result], [1, 2, 3, 4]);
});

test("readLimitedBytes cancels and rejects on overflow", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([1, 2, 3]));
      controller.enqueue(Uint8Array.from([4]));
    },
    cancel() {
      cancelled = true;
    },
  });

  await assert.rejects(
    readLimitedBytes(stream, 3, () => new Error("too large")),
    /too large/,
  );
  assert.equal(cancelled, true);
});

test("readLimitedBytes rejects invalid limits before acquiring the stream", async () => {
  await assert.rejects(
    readLimitedBytes(byteStream([1]), -1, () => new Error("large")),
    RangeError,
  );
});
