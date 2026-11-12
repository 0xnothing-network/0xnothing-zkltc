import assert from "node:assert/strict";
import test from "node:test";
import * as viem from "viem";
import type { isTransientRpcError as IsTransientRpcError, litvmRpcUrls as LitvmRpcUrls, litvmTransport as LitvmTransport } from "../../lib/rpcTransport.ts";
import { evaluateModule } from "../helpers/evaluateModule.ts";

const DEFAULT = "https://rpc.testnet.liteforge.zeeve.net";
const { litvmRpcUrls, litvmTransport, isTransientRpcError } = evaluateModule<{
  litvmRpcUrls: typeof LitvmRpcUrls; litvmTransport: typeof LitvmTransport; isTransientRpcError: typeof IsTransientRpcError;
}>(new URL("../../lib/rpcTransport.ts", import.meta.url), {
  viem, "./publicConfig": { LITVM_RPC_URL: DEFAULT },
});

test("the caller's retry count is the only retry budget", () => {
  // One endpoint: a plain HTTP transport, with no fallback layer to repeat its attempts.
  const single = litvmTransport({ retryCount: 2, timeout: 15_000 })({}).config;
  assert.equal(single.type, "http");
  assert.equal(single.retryCount, 2);
  assert.equal(litvmTransport({ retryCount: 0 })({}).config.retryCount, 0);
  assert.equal(litvmTransport()({}).config.retryCount, 1);
  // An override plus the default: failover between them, without a second retry round.
  const pair = litvmTransport({ retryCount: 2 }, "https://custom.rpc")({}).config;
  assert.equal(pair.type, "fallback");
  assert.equal(pair.retryCount, 0);
});

test("only failures in transit count as transient", () => {
  const timeout = new viem.TimeoutError({ body: {}, url: DEFAULT });
  assert.equal(isTransientRpcError(timeout), true);
  assert.equal(isTransientRpcError(new viem.BaseError("read failed", { cause: timeout })), true);
  assert.equal(isTransientRpcError(new viem.BaseError("read failed", { cause: new viem.HttpRequestError({ url: DEFAULT, status: 502 }) })), true);
  assert.equal(isTransientRpcError(new viem.BaseError("execution reverted")), false);
  // A gateway that reports overload as a JSON-RPC error body, which viem relabels as a revert.
  const rpcError = (error: { code: number; message: string; data?: unknown }, status?: number) =>
    new viem.BaseError("read failed", { cause: new viem.RpcRequestError({ body: {}, error, status, url: DEFAULT }) });
  assert.equal(isTransientRpcError(rpcError({ code: -32603, message: "upstream timeout" }, 503)), true);
  assert.equal(isTransientRpcError(rpcError({ code: -32603, message: "upstream timeout" })), true);
  assert.equal(isTransientRpcError(rpcError({ code: 429, message: "too many requests" })), true);
  // A real revert carries its data, whatever code the node used for it.
  assert.equal(isTransientRpcError(rpcError({ code: 3, message: "execution reverted", data: "0x08c379a0" })), false);
  assert.equal(isTransientRpcError(rpcError({ code: -32603, message: "execution reverted", data: "0x08c379a0" })), false);
  assert.equal(isTransientRpcError(rpcError({ code: -32000, message: "execution reverted" })), false);
  assert.equal(isTransientRpcError(new Error("timeout")), false);
});

test("RPC endpoints fail over in a fixed order without duplicates", () => {
  assert.deepEqual(Array.from(litvmRpcUrls()), [DEFAULT]);
  assert.deepEqual(Array.from(litvmRpcUrls("https://custom.rpc")), ["https://custom.rpc", DEFAULT]);
  assert.deepEqual(Array.from(litvmRpcUrls(DEFAULT)), [DEFAULT]);
  assert.deepEqual(Array.from(litvmRpcUrls("")), [DEFAULT]);
});
