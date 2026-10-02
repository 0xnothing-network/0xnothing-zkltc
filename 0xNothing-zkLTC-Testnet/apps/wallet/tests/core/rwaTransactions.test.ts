import assert from "node:assert/strict";
import test from "node:test";
import { evaluateModule } from "../../../web/tests/helpers/evaluateModule.ts";
import type { RwaMarketConfig } from "../../../../shared/rwa/core.ts";
import type { TxExecutionContext } from "../../src/core/services/tx.ts";

const from = `0x${"11".repeat(20)}` as const;
const config = { chainId: 4441, market: `0x${"22".repeat(20)}`, asset: `0x${"33".repeat(20)}`,
  settlement: `0x${"44".repeat(20)}`, assetSymbol: "RWA", settlementSymbol: "NUSD" } as RwaMarketConfig;

function setup(change: "none" | "account" | "network" | "lock" = "none") {
  let account: string = from;
  let unlocked = true;
  const network = { id: "litvm-4441", chainId: 4441, rpcUrl: "https://rpc.example" };
  const rpc = { activeNetwork: network, publicClient: {
    getBlock: async () => ({ number: 1n, timestamp: 1000n }),
    readContract: async () => [100n, 1n, 101n],
  } };
  const writes: unknown[] = [];
  const approvals: unknown[] = [];
  const module = evaluateModule<{ tradeRwa: (params: unknown) => Promise<string> }>(
    new URL("../../src/core/services/rwa.ts", import.meta.url), {
      viem: { erc20Abi: [] },
      "../../config/networks": { isLitvmNetwork: (n: typeof network) => n.id === "litvm-4441", networkIdentity: (n: typeof network) => `${n.id}:${n.rpcUrl}` },
      "../keyring/vault": { isUnlocked: async () => unlocked, readAccounts: async () => ({ active: account, accounts: [] }) },
      "../rpc/client": rpc,
      "./tx": {
        ensureAllowance: async (params: unknown, context: TxExecutionContext) => {
          approvals.push(params); await context.assertReady?.();
          if (change === "account") account = config.asset;
          if (change === "network") rpc.activeNetwork = { ...network, rpcUrl: "https://changed.example" };
          if (change === "lock") unlocked = false;
        },
        writeCall: async (request: unknown, context: TxExecutionContext) => {
          await context.assertReady?.(); writes.push(request); return "0xhash";
        },
      },
      "../../../../../shared/rwa/abi": { rwaMarketAbi: [], rwaOracleAbi: [] },
      "../../../../../shared/rwa/markets": { rwaMarkets: [config] },
      "../../../../../shared/rwa/core": { readRwaState: async () => ({}), decodeQuote: (value: unknown) => value },
    },
  );
  return { ...module, writes, approvals };
}

const params = { config, from, buy: true, amount: 1n, limit: 102n, deadline: 1300n };

test("RWA approval cannot continue into a trade after account, RPC or lock changes", async () => {
  for (const change of ["account", "network", "lock"] as const) {
    const run = setup(change);
    await assert.rejects(run.tradeRwa(params), /changed|locked/);
    assert.equal(run.approvals.length, 1);
    assert.equal(run.writes.length, 0);
  }
});

test("RWA expired and moved quotes do not request approvals", async () => {
  for (const patch of [{ deadline: 999n }, { limit: 100n }]) {
    const run = setup();
    await assert.rejects(run.tradeRwa({ ...params, ...patch }), /expired|outside/);
    assert.equal(run.approvals.length, 0);
    assert.equal(run.writes.length, 0);
  }
});

test("RWA trade preserves reviewed amount, bound and deadline", async () => {
  const run = setup();
  assert.equal(await run.tradeRwa(params), "0xhash");
  assert.equal(run.writes.length, 1);
  const write = run.writes[0] as { functionName: string; args: unknown[] };
  assert.equal(write.functionName, "buy");
  assert.deepEqual(Array.from(write.args), [1n, 102n, 1300n]);
  assert.equal((run.approvals[0] as { amount: bigint }).amount, 102n);
});

test("writeCall rechecks its action session after simulation and before signing", async () => {
  let checks = 0;
  let signed = false;
  const client = {
    simulateContract: async () => ({ request: {} }),
  };
  const module = evaluateModule<{ writeCall: (request: unknown, context: unknown) => Promise<unknown> }>(
    new URL("../../src/core/services/tx.ts", import.meta.url), {
      "../../abis": { erc20Abi: [] }, "../i18n": { t: (key: string) => key },
      "../keyring/vault": { touchSession: async () => {} }, "../lib/errors": {},
      "../platform/locks": { withNamedLock: async (_name: string, task: () => Promise<unknown>) => task() },
      "../rpc/client": { walletClientFor: async () => ({ account: from, writeContract: async () => { signed = true; } }) },
      "./history": {},
    },
  );
  await assert.rejects(module.writeCall({ from, address: config.market, abi: [], functionName: "buy" }, {
    network: {}, client, assertReady: async () => { checks += 1; if (checks === 2) throw new Error("Session changed"); },
  }), /Session changed/);
  assert.equal(checks, 2);
  assert.equal(signed, false);
});
