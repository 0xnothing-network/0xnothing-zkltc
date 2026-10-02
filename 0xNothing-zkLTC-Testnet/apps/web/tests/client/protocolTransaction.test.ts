import assert from "node:assert/strict";
import test from "node:test";
import { evaluateModule } from "../helpers/evaluateModule.ts";
import type { useProtocolTransaction } from "../../features/fi/lib/hooks/useProtocolTransaction.ts";
import { isBlockSyncedQueryKey } from "../../lib/liveData.ts";
import { deliveredTokenAmount } from "../../../../shared/transactions/tokenDelivery.ts";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const HASH = `0x${"a".repeat(64)}`;
const call = { address: ACCOUNT, abi: [], functionName: "deposit" } as const;

function harness(options: { changeAt?: "simulation" | "receipt"; chainId?: number; signer?: string; logs?: unknown[] } = {}) {
  const account = { isConnected: true, address: ACCOUNT, chainId: 4441, connector: { uid: "wallet-a" } };
  let state: { phase: string; message: string; hash?: string };
  let writes = 0;
  let invalidations = 0;
  let predicate: (query: { queryKey: readonly unknown[] }) => boolean = () => false;
  const wallet = {
    account: { address: options.signer ?? ACCOUNT },
    getChainId: async () => options.chainId ?? 4441,
    getAddresses: async () => [account.address],
    writeContract: async () => { writes += 1; return HASH; },
  };
  const publicClient = {
    simulateContract: async (request: unknown) => {
      if (options.changeAt === "simulation") account.address = OTHER;
      return { request };
    },
    waitForTransactionReceipt: async () => {
      if (options.changeAt === "receipt") account.address = OTHER;
      return { status: "success", logs: options.logs ?? [] };
    },
  };
  const evaluated = evaluateModule<{ useProtocolTransaction: typeof useProtocolTransaction }>(
    new URL("../../features/fi/lib/hooks/useProtocolTransaction.ts", import.meta.url),
    {
      react: {
        useCallback: (fn: unknown) => fn,
        useRef: (current: unknown) => ({ current }),
        useState: (initial: typeof state) => { state = initial; return [initial, (next: typeof state) => { state = next; }]; },
      },
      "@tanstack/react-query": { useQueryClient: () => ({ invalidateQueries: async (options: { predicate: typeof predicate }) => { invalidations += 1; predicate = options.predicate; } }) },
      wagmi: {
        useConfig: () => ({}),
        useAccount: () => ({ ...account }),
        usePublicClient: () => publicClient,
        useSwitchChain: () => ({}),
        useWalletClient: () => ({ data: wallet }),
      },
      "wagmi/actions": { getAccount: () => account },
      "@fi/lib/abis/erc20": { erc20Abi: [] },
      "@fi/config/deployment": { deployment: { chain: { id: 4441 } } },
      "@fi/lib/errors": { readableError: (error: Error) => error.message },
      "@/lib/liveData": { isBlockSyncedQueryKey },
      "../../../../../../shared/transactions/tokenDelivery": { deliveredTokenAmount },
    },
  );
  return { tx: evaluated.useProtocolTransaction(), result: () => ({ state, writes, invalidations }), refreshes: (queryKey: readonly unknown[]) => predicate({ queryKey }) };
}

test("an account change while simulating cannot send the old account's request", async () => {
  const run = harness({ changeAt: "simulation" });
  assert.equal(await run.tx.execute({ call }), undefined);
  assert.equal(run.result().writes, 0);
  assert.match(run.result().state.message, /Wallet changed/);
});

test("staged routes spend only receipt-delivered tokens without reading changing wallet balances", async () => {
  const amount = 50n;
  const topic = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
  const run = harness({ logs: [{
    address: OTHER,
    topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topic(OTHER), topic(ACCOUNT)],
    data: `0x${amount.toString(16).padStart(64, "0")}`,
  }] });
  let delivered = 0n;
  assert.equal(await run.tx.execute({ stages: [
    { call, deliveredToken: OTHER },
    { call: (received) => { delivered = received; return { ...call, args: [received] }; } },
  ] }), HASH);
  assert.equal(delivered, amount);
  assert.equal(run.result().writes, 2);
});

test("missing stage delivery stops the next stage and retains the confirmed hash", async () => {
  const run = harness();
  assert.equal(await run.tx.execute({ stages: [{ call, deliveredToken: OTHER }, { call }] }), undefined);
  assert.equal(run.result().writes, 1);
  assert.equal(run.result().state.hash, HASH);
  assert.match(run.result().state.message, /No tokens delivered/);
  assert.equal(run.result().invalidations, 1);
});

test("wallet chain and signer are rechecked immediately before broadcasting", async () => {
  for (const options of [{ chainId: 1 }, { signer: OTHER }]) {
    const run = harness(options);
    assert.equal(await run.tx.execute({ call }), undefined);
    assert.equal(run.result().writes, 0);
    assert.equal(run.result().state.phase, "error");
  }
});

test("a partially completed route retains its hash and refreshes balances", async () => {
  const run = harness({ changeAt: "receipt" });
  assert.equal(await run.tx.execute({ stages: [{ call }, { call }] }), undefined);
  const result = run.result();
  assert.equal(result.writes, 1);
  assert.equal(result.state.hash, HASH);
  assert.equal(result.invalidations, 1);
});

test("an unchanged wallet completes the existing transaction flow", async () => {
  const run = harness();
  assert.equal(await run.tx.execute({ call }), HASH);
  assert.equal(run.result().writes, 1);
  assert.equal(run.result().state.phase, "success");
  assert.equal(run.result().invalidations, 1);
  assert.equal(run.refreshes(["fi-pools"]), true);
  assert.equal(run.refreshes(["fi-activity", ACCOUNT]), true);
  assert.equal(run.refreshes(["readContract", { functionName: "getPosition" }]), true);
  assert.equal(run.refreshes(["readContracts", { contracts: [{ functionName: "redemptionReserve" }] }]), true);
  assert.equal(run.refreshes(["readContract", { functionName: "symbol" }]), false);
  assert.equal(run.refreshes(["pump-markets"]), false);
});
