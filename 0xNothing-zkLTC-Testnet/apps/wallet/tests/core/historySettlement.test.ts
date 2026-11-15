import assert from "node:assert/strict";
import test from "node:test";
import { evaluateModule } from "../../../web/tests/helpers/evaluateModule.ts";
import { chainScope } from "../../src/config/networks.ts";

/** The real chain scoping, anchored to this fixture's stand-in LitVM id. */
function chainScoping(litvmId: string) {
  return {
    chainScope,
    onNetworkChain: (stored: string | undefined, id: string) => chainScope(stored ?? litvmId) === chainScope(id),
  };
}

const owner = `0x${"11".repeat(20)}`;
const hash = `0x${"22".repeat(32)}`;
const litvm = { id: "litvm" };
const other = { id: "other" };

interface Row {
  hash: string;
  account: string;
  networkId?: string;
  kind: string;
  status: string;
  at: number;
  nonce?: number;
}

interface HistoryService {
  listSettled(account: string, network?: { id: string }): Promise<Row[]>;
  listRecords(account: string, network?: { id: string }): Promise<Row[]>;
  listWatched(account: string, network?: { id: string }): Promise<Row[]>;
  clearRecords(account: string, network?: { id: string }): Promise<void>;
}

/** Real history.ts over an in-memory book and a scripted node. */
function fixture(rows: Row[], node: {
  minedNonce?: () => Promise<number>;
  transaction?: () => Promise<unknown>;
  receipt?: () => Promise<unknown>;
} = {}) {
  let book: Record<string, Row[]> = { [owner]: rows };
  const reads: string[] = [];
  const client = {
    getTransactionReceipt: async () => {
      reads.push("receipt");
      if (node.receipt) return node.receipt();
      throw new Error("receipt not found");
    },
    getTransactionCount: async () => { reads.push("count"); return node.minedNonce ? node.minedNonce() : 0; },
    getTransaction: async () => { reads.push("transaction"); return node.transaction ? node.transaction() : {}; },
  };
  const service = evaluateModule<HistoryService>(new URL("../../src/core/services/history.ts", import.meta.url), {
    "../i18n": { t: (key: string) => key },
    "../../config/networks": { LITVM_NETWORK: litvm, ...chainScoping(litvm.id) },
    "../platform/storage": { persistentStore: {
      get: async () => book,
      set: async (_key: string, value: typeof book) => { book = value; },
    } },
    "../platform/storageKeys": { STORAGE_KEYS: { history: "history" } },
    "../platform/locks": { withNamedLock: (_name: string, action: () => unknown) => action() },
    "../rpc/client": { activeNetwork: litvm, publicClientFor: () => client },
  });
  return { service, reads, book: () => book };
}

const notFound = () => Promise.reject(Object.assign(new Error("Transaction could not be found"), {
  name: "TransactionNotFoundError",
}));
const pending = (patch: Partial<Row> = {}): Row => ({
  hash, account: owner, kind: "send", status: "pending", at: 1, nonce: 5, ...patch,
});

test("a pending row whose nonce was taken by another transaction settles as dropped", async () => {
  const run = fixture([pending()], { minedNonce: async () => 6, transaction: notFound });
  assert.equal((await run.service.listSettled(owner, litvm))[0]?.status, "dropped");
  assert.equal(run.book()[owner]?.[0]?.status, "dropped");
  // The nonce is read before the transaction, so one mined in between is still found.
  assert.deepEqual(run.reads, ["receipt", "count", "transaction"]);
});

test("a pending row stays pending whenever the wallet cannot be sure it was dropped", async () => {
  const cases = [
    // The nonce has not moved: it may still be mined.
    { minedNonce: async () => 5, transaction: notFound },
    // The node still knows the transaction.
    { minedNonce: async () => 6, transaction: async () => ({ hash }) },
    // A failed read is not an answer.
    { minedNonce: async () => 6, transaction: () => Promise.reject(new Error("The request took too long")) },
    { minedNonce: () => Promise.reject(new Error("HTTP 502")), transaction: notFound },
  ];
  for (const node of cases) {
    const run = fixture([pending()], node);
    assert.equal((await run.service.listSettled(owner, litvm))[0]?.status, "pending");
    assert.equal(run.book()[owner]?.[0]?.status, "pending");
  }
});

test("a dropped row whose receipt appears later settles as success", async () => {
  // The drop was judged from a lagging node; the transaction was mined.
  const run = fixture([pending({ status: "dropped" })], {
    minedNonce: async () => 6,
    transaction: notFound,
    receipt: async () => ({ status: "success" }),
  });
  assert.equal((await run.service.listSettled(owner, litvm))[0]?.status, "success");
  assert.equal(run.book()[owner]?.[0]?.status, "success");
  assert.deepEqual(run.reads, ["receipt"]);
});

test("a dropped row with no receipt stays dropped and is never judged by nonce again", async () => {
  const run = fixture([pending({ status: "dropped" })], { minedNonce: async () => 6, transaction: notFound });
  assert.equal((await run.service.listSettled(owner, litvm))[0]?.status, "dropped");
  assert.equal(run.book()[owner]?.[0]?.status, "dropped");
  assert.deepEqual(run.reads, ["receipt"]);
});

test("rows stored by 1.0.9, without a nonce, keep today's pending behaviour and cost no extra reads", async () => {
  const legacy: Row = { hash, account: owner, kind: "send", status: "pending", at: 1 };
  const run = fixture([legacy], { minedNonce: async () => 99, transaction: notFound });
  assert.equal((await run.service.listSettled(owner))[0]?.status, "pending");
  assert.deepEqual(run.reads, ["receipt"]);
});

test("clearing history removes the shown network's settled rows only", async () => {
  const row = (tag: string, patch: Partial<Row>): Row => ({
    hash: `0x${tag.repeat(32)}`, account: owner, kind: "send", status: "success", at: 1, ...patch,
  });
  const run = fixture([
    row("01", { networkId: "other" }),
    row("02", {}), // a 1.0.9 row with no network belongs to LitVM
    row("03", { networkId: "litvm", status: "failed" }),
    row("04", { networkId: "litvm", status: "pending" }),
    row("05", { networkId: "other", status: "pending" }),
  ]);
  await run.service.clearRecords(owner, other);
  assert.deepEqual((await run.service.listRecords(owner, other)).map((entry) => entry.hash), [`0x${"05".repeat(32)}`]);
  assert.equal((await run.service.listRecords(owner, litvm)).length, 3);

  await run.service.clearRecords(owner, litvm);
  assert.deepEqual((await run.service.listRecords(owner, litvm)).map((entry) => entry.hash), [`0x${"04".repeat(32)}`]);
  assert.deepEqual((await run.service.listRecords(owner, other)).map((entry) => entry.hash), [`0x${"05".repeat(32)}`]);
});

test("clearing the last rows of an account removes its entry", async () => {
  const run = fixture([pending({ status: "success" })]);
  await run.service.clearRecords(owner);
  assert.equal(Object.hasOwn(run.book(), owner), false);
});

test("a custom chain's history survives its profile being re-added with a new RPC", async () => {
  // 1.0.9 stored the row under the old profile id, which hashes the old RPC.
  const run = fixture(
    [pending({ networkId: "custom-10-aaaa", nonce: undefined })],
    { receipt: async () => ({ status: "success" }) },
  );
  const readded = { id: "custom-10-bbbb" };
  assert.equal((await run.service.listRecords(owner, readded)).length, 1);
  // Listed under the new id AND settled under it: a row shown but never
  // patched would stay pending forever.
  assert.equal((await run.service.listSettled(owner, readded))[0]?.status, "success");
  assert.equal(run.book()[owner]?.[0]?.status, "success");
  // Another chain, or LitVM, never sees it.
  assert.equal((await run.service.listRecords(owner, { id: "custom-11-aaaa" })).length, 0);
  assert.equal((await run.service.listRecords(owner, litvm)).length, 0);
});

test("Home's read asks the node nothing while no row is pending, not even for a dropped row", async () => {
  const run = fixture([
    pending({ status: "dropped" }),
    pending({ hash: `0x${"33".repeat(32)}`, status: "success" }),
  ]);
  assert.equal((await run.service.listWatched(owner, litvm)).length, 2);
  assert.deepEqual(run.reads, []);
});

test("Home's read settles a pending row through listSettled", async () => {
  const run = fixture([pending()], { receipt: async () => ({ status: "success" }) });
  assert.equal((await run.service.listWatched(owner, litvm))[0]?.status, "success");
  assert.deepEqual(run.reads, ["receipt"]);
  assert.equal(run.book()[owner]?.[0]?.status, "success");
});
