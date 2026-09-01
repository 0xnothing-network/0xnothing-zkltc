import assert from "node:assert/strict";
import test from "node:test";
import {
  readLimitedJson,
  ResponseBodyTooLargeError,
} from "../../lib/server/readLimitedJson.ts";

test("readLimitedJson parses an exact-limit response", async () => {
  const body = JSON.stringify({ ok: true });
  const result = await readLimitedJson<{ ok: boolean }>(
    new Response(body),
    new TextEncoder().encode(body).byteLength,
  );
  assert.deepEqual(result, { ok: true });
});

test("readLimitedJson rejects a declared oversized response before parsing", async () => {
  const response = new Response("{}", { headers: { "Content-Length": "1024" } });
  await assert.rejects(
    readLimitedJson(response, 16),
    ResponseBodyTooLargeError,
  );
});

test("readLimitedJson bounds chunked responses without a content length", async () => {
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"value":"'));
      controller.enqueue(new TextEncoder().encode('too-large"}'));
      controller.close();
    },
  }));
  await assert.rejects(
    readLimitedJson(response, 8),
    ResponseBodyTooLargeError,
  );
});

test("readLimitedJson rejects malformed JSON", async () => {
  await assert.rejects(readLimitedJson(new Response("{"), 16), SyntaxError);
});
