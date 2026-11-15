import assert from "node:assert/strict";
import test from "node:test";
import * as viem from "viem";
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
const secondHash = `0x${"88".repeat(32)}`;
const translate = (key: string, params?: Record<string, string>) => params ? `${key} ${JSON.stringify(params)}` : key;
const errors = evaluateModule<{
  StagedSwapError: new (...args: unknown[]) => Error & { hash: string; delivered: bigint; bridged: string };
  BroadcastUnknownError: new (hash: string, cause: unknown) => Error & { hash: string };
}>(new URL("../../src/core/lib/errors.ts", import.meta.url), { viem, "../i18n": { t: translate } });

interface Write { functionName: string; args: bigint[]; label: { key: string; params?: Record<string, string> } }
interface Context { onSigned?: (hash: string) => void }
type Swap = {
  executeSwap(params: unknown): Promise<string>;
  loadPendingStagedSwap(from: string, now?: number): Promise<{ stage1Hash: string; delivered: bigint } | null>;
};

/**
 * The real swap service over scripted writes. Each write announces its signed
 * hash through the context, as tx.ts does. `fail` makes the n-th write (1-based)
 * throw, before signing unless `failSigned`, which throws after it the way an
 * unknown broadcast does. `approvalFails` makes the stage-two approval throw.
 */
function fixture(delivered: bigint | null, options: {
  fail?: number;
  failSigned?: boolean;
  approvalFails?: boolean;
  balance?: () => Promise<bigint>;
  receipt?: () => Promise<unknown>;
  settle?: () => Promise<unknown>;
} = {}) {
  const calls: Write[] = [];
  const approvals: Array<{ amount: bigint }> = [];
  const store = new Map<string, unknown>();
  const markerSeen: unknown[] = [];
  const topic = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
  const logs = delivered === null ? [] : [{ address: addresses.nusd,
    topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topic(zeroAddress), topic(owner)],
    data: `0x${delivered.toString(16).padStart(64, "0")}` }];
  const module = evaluateModule<Swap>(
    new URL("../../src/core/services/swap.ts", import.meta.url), {
      viem: { zeroAddress }, "../../abis": { erc20Abi: [] }, "../../config/contracts": { CONTRACTS: addresses },
      "../../config/assets": { NUSD_TOKEN: { decimals: 18 } },
      "../../../../../shared/transactions/tokenDelivery": { deliveredTokenAmount },
      "../i18n": { t: (key: string) => key }, "../lib/format": { formatAmount: String }, "../lib/swapMath": swapMath,
      "../lib/errors": errors,
      "../platform/locks": { withNamedLock: (_name: string, task: () => Promise<unknown>) => task() },
      "../platform/storage": { persistentStore: {
        get: async (key: string) => store.get(key) ?? null,
        set: async (key: string, value: unknown) => { store.set(key, value); },
      } },
      "../platform/storageKeys": { STORAGE_KEYS: { pendingStagedSwap: "staged" } },
      "../rpc/client": { activeNetwork: { id: "litvm", rpcUrl: "https://rpc.example" }, publicClient: {
        readContract: async () => {
          if (options.balance) return options.balance();
          throw new Error("Staged delivery must never read a changing wallet balance");
        },
        waitForTransactionReceipt: async () => options.settle ? options.settle() : ({ status: "success", logs }),
        getTransactionReceipt: async () => options.receipt ? options.receipt() : ({ status: "success", logs }),
      } },
      "./tx": {
        ensureAllowance: async (params: { amount: bigint }) => {
          approvals.push(params);
          if (options.approvalFails && calls.length > 0) throw new Error("err.txReverted");
        },
        writeCall: async (request: Write, context?: Context) => {
          calls.push(request);
          const signed = calls.length === 1 ? hash : secondHash;
          if (options.fail === calls.length && !options.failSigned) throw new Error("execution reverted: minOut");
          // What storage held just before this write was signed.
          markerSeen.push(store.get("staged"));
          context?.onSigned?.(signed);
          if (options.fail === calls.length) throw new errors.BroadcastUnknownError(signed, new Error("timed out"));
          return signed;
        },
      },
    },
  );
  const marker = () => Object.values((store.get("staged") ?? {}) as Record<string, { stage1Hash: string }>);
  return { ...module, calls, approvals, store, marker, markerSeen };
}

function params(kind: "oracle-mint" | "oracle-redeem", quotedAt = Date.now()) {
  const tokenIn = kind === "oracle-mint" ? native : token;
  const tokenOut = kind === "oracle-mint" ? token : native;
  return { from: owner, tokenIn, tokenOut, amountIn: 100n, slippageBps: 50,
    route: { networkId: "litvm", rpcUrl: "https://rpc.example", tokenInId: tokenIn.id, tokenOutId: tokenOut.id,
      quotedAmountIn: 100n, kind, amountOut: 5_000n, bridgeAmount: 50n, paused: false, quotedAt,
      path: kind === "oracle-mint" ? [addresses.nusd, token.address] : [token.address, addresses.nusd] },
  };
}

test("both staged swap directions spend exact receipt proceeds and retain the final slippage floor", async () => {
  for (const kind of ["oracle-mint", "oracle-redeem"] as const) {
    const run = fixture(40n);
    // The swap's own hash is the second leg's.
    assert.equal(await run.executeSwap(params(kind)), secondHash);
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

test("a reviewed quote older than the limit is refused before anything is signed", async () => {
  const run = fixture(40n);
  await assert.rejects(run.executeSwap(params("oracle-mint", Date.now() - 31_000)), /err\.quoteStale/);
  await assert.rejects(run.executeSwap(params("oracle-mint", Date.now() + 60_000)), /err\.quoteStale/);
  assert.equal(run.calls.length, 0);
  assert.equal(run.approvals.length, 0);
});

test("stage one is recorded as the NUSD it bridges, not as the whole swap", async () => {
  for (const kind of ["oracle-mint", "oracle-redeem"] as const) {
    const run = fixture(40n);
    await run.executeSwap(params(kind));
    assert.equal(JSON.stringify(run.calls[0]!.label),
      JSON.stringify({ key: "tx.swapStep1", params: { paid: `100 ${params(kind).tokenIn.symbol}`, bridged: "50" } }));
    assert.equal(run.calls[1]!.label.key, "tx.swap");
  }
});

test("a stage-two failure says that stage one already delivered NUSD", async () => {
  for (const [kind, options] of [
    ["oracle-mint", { fail: 2 }],
    ["oracle-mint", { approvalFails: true }],
    ["oracle-redeem", { fail: 2 }],
  ] as const) {
    const run = fixture(40n, options);
    await assert.rejects(run.executeSwap(params(kind)), (error: unknown) => {
      assert.ok(error instanceof errors.StagedSwapError, String(error));
      assert.equal(error.hash, hash);
      assert.equal(error.delivered, 40n);
      assert.equal(error.bridged, "40");
      assert.match(error.message, /^swap\.stagedFailed /);
      return true;
    });
    // The user has been told: nothing is left to offer later.
    assert.deepEqual(run.marker(), []);
  }
});

test("a second leg that was signed and then lost keeps its own unknown outcome", async () => {
  for (const kind of ["oracle-mint", "oracle-redeem"] as const) {
    const run = fixture(40n, { fail: 2, failSigned: true });
    await assert.rejects(run.executeSwap(params(kind)), (error: unknown) => {
      assert.ok(error instanceof errors.BroadcastUnknownError);
      assert.ok(!(error instanceof errors.StagedSwapError));
      return true;
    });
    // Its signature already withdrew the offer to finish, so it cannot be sent twice.
    assert.deepEqual(run.marker(), []);
  }
});

test("a staged swap is marked when stage one is signed and unmarked when stage two is", async () => {
  for (const kind of ["oracle-mint", "oracle-redeem"] as const) {
    const run = fixture(40n);
    await run.executeSwap(params(kind));
    assert.equal(run.markerSeen[0], undefined);
    const beforeSecond = run.markerSeen[1] as Record<string, { stage1Hash: string; tokenOutId: string }>;
    assert.equal(JSON.stringify(Object.values(beforeSecond).map((entry) => [entry.stage1Hash, entry.tokenOutId])),
      JSON.stringify([[hash, params(kind).tokenOut.id]]));
    assert.deepEqual(run.marker(), []);
  }
});

test("a swap that stopped after stage one is offered while its NUSD is still there", async () => {
  // The page died while stage one settled: the receipt wait never returned.
  const stopped = async (options: Parameters<typeof fixture>[1]) => {
    const run = fixture(40n, { ...options, settle: async () => { throw new Error("stopped"); } });
    await assert.rejects(run.executeSwap(params("oracle-mint")), /stopped/);
    return run;
  };

  const run = await stopped({ balance: async () => 40n });
  // The marker outlives the page, and the receipt proves what stage one delivered.
  const pending = await run.loadPendingStagedSwap(owner);
  assert.equal(pending?.stage1Hash, hash);
  assert.equal(pending?.delivered, 40n);

  // NUSD already spent: the offer is gone for good.
  const spent = await stopped({ balance: async () => 39n });
  assert.equal(await spent.loadPendingStagedSwap(owner), null);
  assert.deepEqual(spent.marker(), []);

  // Older than a day: gone for good.
  const old = await stopped({ balance: async () => 40n });
  assert.equal(await old.loadPendingStagedSwap(owner, Date.now() + 24 * 60 * 60 * 1_000 + 1), null);
  assert.deepEqual(old.marker(), []);

  // Stage one reverted: nothing was delivered, nothing to finish.
  const reverted = await stopped({ balance: async () => 40n, receipt: async () => ({ status: "reverted", logs: [] }) });
  assert.equal(await reverted.loadPendingStagedSwap(owner), null);
  assert.deepEqual(reverted.marker(), []);

  // Unreadable for now: not offered, but kept for the next look.
  const unread = await stopped({ balance: async () => { throw new Error("HTTP 502"); } });
  assert.equal(await unread.loadPendingStagedSwap(owner), null);
  assert.equal(unread.marker().length, 1);

  // Another account sees nothing.
  assert.equal(await run.loadPendingStagedSwap(`0x${"99".repeat(20)}`), null);
});

test("a swap still running in this page is never offered for finishing", async () => {
  let land!: () => void;
  const landed = new Promise<void>((resolve) => { land = resolve; });
  const run = fixture(40n, { balance: async () => 40n, settle: async () => {
    await landed;
    throw new Error("stopped");
  } });
  const swap = assert.rejects(run.executeSwap(params("oracle-mint")), /stopped/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(run.marker().length, 1);
  assert.equal(await run.loadPendingStagedSwap(owner), null);
  land();
  await swap;
  assert.equal((await run.loadPendingStagedSwap(owner))?.stage1Hash, hash);
});
