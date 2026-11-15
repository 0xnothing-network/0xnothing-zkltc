import assert from "node:assert/strict";
import test from "node:test";
import * as viem from "viem";
import { evaluateModule } from "../../../web/tests/helpers/evaluateModule.ts";

interface ErrorsModule {
  describeError(error: unknown): string;
  BroadcastUnknownError: new (hash: string, cause: unknown) => Error & { hash: string };
  StagedSwapError: new (hash: string, delivered: bigint, bridged: string, cause: unknown) => Error & {
    hash: string; delivered: bigint; bridged: string;
  };
}

const errors = evaluateModule<ErrorsModule>(new URL("../../src/core/lib/errors.ts", import.meta.url), {
  viem,
  "../i18n": {
    t: (key: string, params?: Record<string, string>) => params ? `${key} ${JSON.stringify(params)}` : key,
  },
});
const hash = `0x${"ab".repeat(32)}`;

test("an unknown broadcast is never described as a timeout or a refusal", () => {
  const lost = new errors.BroadcastUnknownError(hash, new Error("The request took too long to respond."));
  assert.equal(lost.hash, hash);
  assert.equal(errors.describeError(lost), "err.broadcastUnknown");
  // The same cause on its own still reads as a timeout.
  assert.equal(errors.describeError(new Error("The request timed out")), "err.timeout");
});

test("a stage-2 failure says that stage 1 already delivered NUSD, and why stage 2 stopped", () => {
  const staged = new errors.StagedSwapError(hash, 50n * 10n ** 18n, "50", new Error("The request timed out"));
  assert.equal(staged.delivered, 50n * 10n ** 18n);
  assert.equal(errors.describeError(staged), `swap.stagedFailed ${JSON.stringify({ bridged: "50", reason: "err.timeout" })}`);
});

test("a dapp's 'denied' revert is shown as a revert, a signer refusal as a rejection", () => {
  const revert = new viem.EstimateGasExecutionError(
    new viem.ExecutionRevertedError({ message: "execution reverted: Access denied" }),
    { account: undefined } as never,
  );
  const shown = errors.describeError(revert);
  assert.notEqual(shown, "err.rejected");
  assert.match(shown, /^err\.reverted /u);
  assert.match(shown, /Access denied/u);
  assert.equal(errors.describeError(new Error("User denied transaction signature")), "err.rejected");
  assert.equal(errors.describeError(new Error("Request rejected by the user")), "err.rejected");
  assert.equal(errors.describeError(new viem.UserRejectedRequestError(new Error("no"))), "err.rejected");
});

test("an RPC endpoint's 403 says the endpoint refused, not that the user did", () => {
  const refused = new viem.HttpRequestError({ url: "https://rpc.invalid", status: 403, details: "access denied" });
  assert.equal(errors.describeError(refused), "err.rpcRefused");
  // Wrapped the way a read surfaces it.
  assert.equal(
    errors.describeError(new viem.CallExecutionError(refused, { account: undefined } as never)),
    "err.rpcRefused",
  );
  assert.notEqual(
    errors.describeError(new viem.HttpRequestError({ url: "https://rpc.invalid", status: 500 })),
    "err.rpcRefused",
  );
});
