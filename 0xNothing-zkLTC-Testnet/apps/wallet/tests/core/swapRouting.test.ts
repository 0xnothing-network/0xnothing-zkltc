import assert from "node:assert/strict";
import test from "node:test";
import { zeroAddress } from "viem";
import { evaluateModule } from "../../../web/tests/helpers/evaluateModule.ts";
import { deliveredTokenAmount } from "../../../../shared/transactions/tokenDelivery.ts";

const addresses = {
  nusd: `0x${"11".repeat(20)}`, wzkltc: `0x${"22".repeat(20)}`,
  dexFactory: `0x${"33".repeat(20)}`, dexRouter: `0x${"44".repeat(20)}`,
  pumpFactory: `0x${"55".repeat(20)}`,
};
const token = { id: "token", address: `0x${"66".repeat(20)}`, decimals: 18, symbol: "TOKEN" };
const native = { id: "native", decimals: 18, symbol: "zkLTC" };

function fixture(oraclePause: boolean | "unreadable", swapsPaused = false) {
  const readContract = async ({ functionName, args = [] }: { functionName: string; args?: unknown[] }) => {
    if (functionName === "getPair") return `0x${"77".repeat(20)}`;
    if (functionName === "getReserves") return [1_000_000n, 1_000_000n, 0];
    if (functionName === "totalSupply") return 1_000_000n;
    if (functionName === "swapsPaused") return swapsPaused;
    if (functionName === "mintPaused" || functionName === "redeemPaused") {
      if (oraclePause === "unreadable") throw new Error("RPC unavailable");
      return oraclePause;
    }
    if (functionName === "quoteMint") return 2_000n;
    if (functionName === "quoteRedeem") return 3_000n;
    if (functionName === "getAmountsOut") {
      const path = args[1] as string[];
      return [args[0], path.length === 3 ? 800n : path.includes(addresses.nusd) ? 2_000n : 1_000n];
    }
    throw new Error(`Unexpected read: ${functionName}`);
  };
  return evaluateModule<{
    quoteSwap(params: unknown): Promise<{ kind: string; amountOut: bigint; paused: boolean }>;
  }>(new URL("../../src/core/services/swap.ts", import.meta.url), {
    viem: { zeroAddress }, "../../abis": {}, "../../config/contracts": { CONTRACTS: addresses },
    "../../../../../shared/transactions/tokenDelivery": { deliveredTokenAmount },
    "../i18n": {}, "../lib/format": {}, "../lib/swapMath": {}, "./tx": {},
    "../rpc/client": { activeNetwork: { id: "litvm", rpcUrl: "https://rpc.example" }, publicClient: { readContract, multicall: async () => [50n, 10n, 10n] } },
  });
}

test("live AMM routes remain available when a higher-output oracle route is paused or unreadable", async () => {
  for (const paused of [true, "unreadable"] as const) {
    for (const [tokenIn, tokenOut] of [[native, token], [token, native]]) {
      const quote = await fixture(paused).quoteSwap({ tokenIn, tokenOut, amountIn: 100n });
      assert.equal(quote.kind, "direct");
      assert.equal(quote.amountOut, 1_000n);
      assert.equal(quote.paused, false);
    }
  }
});

test("healthy oracle routes still compete on delivered output", async () => {
  for (const [tokenIn, tokenOut, kind] of [[native, token, "oracle-mint"], [token, native, "oracle-redeem"]]) {
    const quote = await fixture(false).quoteSwap({ tokenIn, tokenOut, amountIn: 100n });
    assert.equal(quote.kind, kind);
    assert.equal(quote.paused, false);
  }
});

test("all-paused routes remain fail-closed and retain a quote for the pause warning", async () => {
  const quote = await fixture(true, true).quoteSwap({ tokenIn: native, tokenOut: token, amountIn: 100n });
  assert.equal(quote.kind, "oracle-mint");
  assert.equal(quote.paused, true);
  assert.equal(quote.amountOut, 2_000n);
});
