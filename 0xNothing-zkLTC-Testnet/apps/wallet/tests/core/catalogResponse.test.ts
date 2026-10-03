import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const limit = 32;

function readMarketResponse() {
  const file = new URL("../../src/core/services/marketCatalog.ts", import.meta.url);
  const source = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "boundedText");
  assert.ok(declaration);
  const code = ts.transpileModule(`${declaration.getText(source)}\nboundedText;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return runInNewContext(code, { MAX_RESPONSE_BYTES: limit, TextDecoder, Uint8Array }) as (response: Response) => Promise<string>;
}

test("market responses cancel a body rejected by its declared size", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([123])); },
    cancel() { cancelled = true; },
  });
  const response = new Response(body, { headers: { "Content-Length": String(limit + 1) } });
  await assert.rejects(readMarketResponse()(response), /too large/);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test("market response overflow cancels the stream and releases its reader", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(limit + 1)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readMarketResponse()(new Response(body)), /too large/);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test("market response readers are released after success or an upstream stream failure", async () => {
  const response = new Response('{"ok":true}');
  assert.equal(await readMarketResponse()(response), '{"ok":true}');
  assert.equal(response.body?.locked, false);
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new Error("Upstream stream failed")); },
  });
  await assert.rejects(readMarketResponse()(new Response(body)), /Upstream stream failed/);
  assert.equal(body.locked, false);
});
