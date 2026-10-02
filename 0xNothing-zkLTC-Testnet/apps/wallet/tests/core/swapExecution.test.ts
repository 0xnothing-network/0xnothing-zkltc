import assert from "node:assert/strict";
import test from "node:test";
import { zeroAddress } from "viem";
import { evaluateModule } from "../../../web/tests/helpers/evaluateModule.ts";
import { deliveredTokenAmount } from "../../../../shared/transactions/tokenDelivery.ts";
import * as swapMath from "../../src/core/lib/swapMath.ts";

const owner = `0x${"11".repeat(20)}`;
const addresses = {
  nusd: `0x${"22".repeat(20)}`, wzkltc: `0x${"33".repeat(20)}`,
  dexRouter: `0x${"44".repeat(20)}`, dexFactory: `0x${"55".repeat(20)}`,
};
const token = { id: "token", address: `0x${"66".repeat(20)}`, symbol: "TOKEN", decimals: 18 };
const native = { id: "native", symbol: "zkLTC", decimals: 18 };
const hash = `0x${"77".repeat(32)}`;

function fixture(delivered: bigint | null) {
  const calls: Array<{ functionName: string; args: bigint[] }> = [];
  const approvals: Array<{ amount: bigint }> = [];
  const topic = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
  const logs = delivered === null ? [] : [{ address: addresses.nusd,
    topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topic(zeroAddress), topic(owner)],
    data: `0x${delivered.toString(16).padStart(64, "0")}` }];
  const module = evaluateModule<{ executeSwap(params: unknown): Promise<string> }>(
    new URL("../../src/core/services/swap.ts", import.meta.url), {
      viem: { zeroAddress }, "../../abis": {}, "../../config/contracts": { CONTRACTS: addresses },
      "../../../../../shared/transactions/tokenDelivery": { deliveredTokenAmount },
      "../i18n": { t: (key: string) => key }, "../lib/format": { formatAmount: String }, "../lib/swapMath": swapMath,
      "../rpc/client": { activeNetwork: { id: "litvm", rpcUrl: "https://rpc.example" }, publicClient: {
        readContract: async () => { throw new Error("Staged delivery must never read a changing wallet balance"); },
        waitForTransactionReceipt: async () => ({ status: "success", logs }),
      } },
      "./tx": {
        ensureAllowance: async (params: { amount: bigint }) => { approvals.push(params); },
        writeCall: async (request: typeof calls[number]) => { calls.push(request); return hash; },
      },
    },
  );
  return { ...module, calls, approvals };
}

function params(kind: "oracle-mint" | "oracle-redeem") {
  const tokenIn = kind === "oracle-mint" ? native : token;
  const tokenOut = kind === "oracle-mint" ? token : native;
  return { from: owner, tokenIn, tokenOut, amountIn: 100n, slippageBps: 50,
    route: { networkId: "litvm", rpcUrl: "https://rpc.example", tokenInId: tokenIn.id, tokenOutId: tokenOut.id,
      quotedAmountIn: 100n, kind, amountOut: 5_000n, bridgeAmount: 50n, paused: false,
      path: kind === "oracle-mint" ? [addresses.nusd, token.address] : [token.address, addresses.nusd] },
  };
}

test("both staged swap directions spend exact receipt proceeds and retain the final slippage floor", async () => {
  for (const kind of ["oracle-mint", "oracle-redeem"] as const) {
    const run = fixture(40n);
    assert.equal(await run.executeSwap(params(kind)), hash);
    assert.equal(run.calls.length, 2);
    const final = run.calls[1]!;
    assert.equal(final.args[0], 40n);
    assert.equal(final.args[1], 4_975n);
    if (kind === "oracle-mint") assert.equal(run.approvals[0]!.amount, 40n);
  }
});

test("a confirmed first leg with missing delivery cannot trigger a second swap or extra approval", async () => {
  for (const kind of ["oracle-mint", "oracle-redeem"] as const) {
    const run = fixture(null);
    await assert.rejects(run.executeSwap(params(kind)), /No tokens delivered/);
    assert.equal(run.calls.length, 1);
    assert.equal(run.approvals.length, kind === "oracle-mint" ? 0 : 1);
  }
});
