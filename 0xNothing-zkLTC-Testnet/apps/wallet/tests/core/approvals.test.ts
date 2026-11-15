import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evaluateModule } from "../../../web/tests/helpers/evaluateModule.ts";
import * as approveAmount from "../../src/core/lib/approveAmount.ts";
import { STORAGE_KEYS } from "../../src/core/platform/storageKeys.ts";

/**
 * Token approvals list (F19): records come from the transaction as it was
 * signed, on the network's own chain, deduped, capped and validated on read.
 * Only public anvil addresses appear here.
 */

/** A JSON-only store, like the real backends; `failSet` makes every write throw. */
function fakeStore(options: { failSet?: boolean } = {}) {
  const map = new Map<string, string>();
  return {
    map,
    async get<T>(key: string): Promise<T | null> {
      return map.has(key) ? JSON.parse(map.get(key)!) as T : null;
    },
    async set(key: string, value: unknown): Promise<void> {
      if (options.failSet) throw new Error("quota");
      map.set(key, JSON.stringify(value));
    },
    async remove(key: string): Promise<void> {
      map.delete(key);
    },
  };
}

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const lock = { withNamedLock: (_name: string, task: () => Promise<unknown>) => task() };

type Approvals = typeof import("../../src/core/services/approvals.ts");

/** `supportsInterface` answers what `erc165` returns or throws; ERC-20s mostly revert. */
function loadApprovals(store = fakeStore(), erc165: (token: string) => Promise<unknown> = async () => {
  throw new Error("execution reverted");
}) {
  const probes: string[] = [];
  const module = evaluateModule<Approvals>(new URL("../../src/core/services/approvals.ts", import.meta.url), {
    "../../abis": { erc165Abi: [] },
    "../rpc/client": {
      publicClientFor: () => ({
        readContract: ({ address, args }: { address: string; args: string[] }) => {
          probes.push(`${address}:${args[0]}`);
          return erc165(address);
        },
      }),
    },
    "../lib/approveAmount": approveAmount,
    "../platform/locks": lock,
    "../platform/storage": { persistentStore: store },
    "../platform/storageKeys": { STORAGE_KEYS },
  });
  return { store, probes, ...module };
}

const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const SPENDER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const TOKEN = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const HASH = `0x${"ab".repeat(32)}` as const;
const NETWORK = { id: "litvm-4441", chainId: 4441, rpcUrl: "https://rpc.example" };

const word = (hex: string): string => hex.replace(/^0x/u, "").toLowerCase().padStart(64, "0");
const approveData = (spender: string, amount: bigint, selector = approveAmount.APPROVE_SELECTOR): `0x${string}` =>
  `0x${selector.slice(2)}${word(spender)}${word(amount.toString(16))}`;

/** tx.ts with a signer that signs `signedData` whatever the request asked for. */
function loadTx(approvals: Pick<Approvals, "noteSignedApproval">, options: {
  signedData?: `0x${string}`;
  chainId?: number;
  simulateFails?: boolean;
} = {}) {
  let signs = 0;
  const service = evaluateModule<typeof import("../../src/core/services/tx.ts")>(
    new URL("../../src/core/services/tx.ts", import.meta.url), {
      "../../abis": { erc20Abi: [] }, "../i18n": { t: (key: string) => key },
      "../keyring/vault": { touchSession: async () => {} }, "../lib/errors": {},
      "../platform/locks": lock,
      "../rpc/client": {
        walletClientFor: async (
          _from: string, _network: unknown, _ready: unknown,
          onSigned: (hash: string, nonce?: number, signed?: unknown) => void,
        ) => ({
          account: ACCOUNT,
          writeContract: async (request: { address: string; args: unknown[] }) => {
            signs += 1;
            onSigned(HASH, 3, {
              to: request.address,
              data: options.signedData ?? approveData(String(request.args[0]), BigInt(String(request.args[1]))),
              chainId: options.chainId ?? 4441,
            });
            return HASH;
          },
        }),
      },
      "./approvals": approvals,
      "./history": { addRecord: async () => {}, setRecordStatus: async () => {} },
    },
  );
  const client = {
    simulateContract: async (request: unknown) => {
      if (options.simulateFails) throw new Error("execution reverted");
      return { request };
    },
    getTransaction: async () => ({}),
    waitForTransactionReceipt: () => new Promise(() => {}),
  };
  const approve = (spender: string, amount: bigint) => service.writeCall({
    from: ACCOUNT as `0x${string}`, address: TOKEN as `0x${string}`, abi: [], functionName: "approve",
    args: [spender, amount], kind: "approve", label: { key: "tx.approve" },
  }, { network: NETWORK as never, client: client as never });
  return { approve, signs: () => signs };
}

/** Lets the fire-and-forget recording finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("an approval is recorded from the signed transaction, not the request", async () => {
  const approvals = loadApprovals();
  // The request names SPENDER; the signed bytes approve OTHER for less.
  const { approve } = loadTx(approvals, { signedData: approveData(OTHER, 5n) });
  assert.equal(await approve(SPENDER, 1000n), HASH);
  await settle();
  const rows = plain(await approvals.listApprovals(ACCOUNT, 4441));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.token, TOKEN.toLowerCase());
  assert.equal(rows[0]?.spender, OTHER.toLowerCase());
  assert.equal(rows[0]?.hash, HASH);
});

test("nothing is recorded when the signature never happened", async () => {
  const approvals = loadApprovals();
  const { approve, signs } = loadTx(approvals, { simulateFails: true });
  await assert.rejects(approve(SPENDER, 1000n), /execution reverted/u);
  await settle();
  assert.equal(signs(), 0);
  assert.deepEqual(plain(await approvals.listApprovals(ACCOUNT, 4441)), []);
  assert.equal(approvals.store.map.size, 0);
});

test("a recording failure does not fail the send", async () => {
  const failing = loadApprovals(fakeStore({ failSet: true }));
  assert.equal(await loadTx(failing).approve(SPENDER, 1000n), HASH);
  // Even a recorder that throws at once is contained.
  const throwing = { noteSignedApproval: () => { throw new Error("broken"); } };
  assert.equal(await loadTx(throwing as never).approve(SPENDER, 1000n), HASH);
  await settle();
});

test("a signed chain id other than the network's is not recorded", async () => {
  const approvals = loadApprovals();
  await loadTx(approvals, { chainId: 1 }).approve(SPENDER, 1000n);
  await settle();
  assert.equal(approvals.store.map.size, 0);
  await approvals.noteSignedApproval(ACCOUNT, NETWORK as never, HASH, { to: TOKEN as `0x${string}`, data: approveData(SPENDER, 1n) });
  assert.equal(approvals.store.map.size, 0, "no chain id at all");
});

test("records are deduped by token and spender, newest first, 64 per account and chain", async () => {
  const approvals = loadApprovals();
  const note = (token: string, spender: string, amount = 1n) => approvals.noteSignedApproval(
    ACCOUNT, NETWORK as never, HASH, { to: token as `0x${string}`, data: approveData(spender, amount), chainId: 4441 },
  );
  await note(TOKEN, SPENDER);
  await new Promise((resolve) => setTimeout(resolve, 2));
  await note(TOKEN, OTHER);
  await new Promise((resolve) => setTimeout(resolve, 2));
  // A revoke (approve 0) of the first pair replaces its row and moves it to the front.
  await note(TOKEN, SPENDER, 0n);
  let rows = plain(await approvals.listApprovals(ACCOUNT, 4441));
  assert.deepEqual(rows.map((row) => row.spender), [SPENDER.toLowerCase(), OTHER.toLowerCase()]);
  // increaseAllowance counts as an approval too.
  await approvals.noteSignedApproval(ACCOUNT, NETWORK as never, HASH, {
    to: OTHER as `0x${string}`, data: approveData(SPENDER, 1n, approveAmount.INCREASE_ALLOWANCE_SELECTOR), chainId: 4441,
  });
  rows = plain(await approvals.listApprovals(ACCOUNT, 4441));
  assert.equal(rows[0]?.token, OTHER.toLowerCase());

  for (let index = 0; index < 70; index += 1) {
    await note(`0x${(index + 1).toString(16).padStart(40, "0")}`, SPENDER);
  }
  rows = plain(await approvals.listApprovals(ACCOUNT, 4441));
  assert.equal(rows.length, approvals.MAX_APPROVALS);
  assert.equal(rows[0]?.token, `0x${(70).toString(16).padStart(40, "0")}`);
  assert.deepEqual(plain(await approvals.listApprovals(ACCOUNT, 1)), []);

  await approvals.forgetApproval(ACCOUNT, 4441, rows[0]!.token, SPENDER);
  assert.equal((await approvals.listApprovals(ACCOUNT, 4441)).length, approvals.MAX_APPROVALS - 1);
});

test("an ERC-721 approve(to, tokenId) is never recorded; a target that does not answer is", async () => {
  const nft = loadApprovals(fakeStore(), async (token) => token === TOKEN.toLowerCase());
  const note = (token: string, data: `0x${string}`) => nft.noteSignedApproval(
    ACCOUNT, NETWORK as never, HASH, { to: token as `0x${string}`, data, chainId: 4441 },
  );
  await note(TOKEN, approveData(SPENDER, 7n));
  assert.deepEqual(plain(await nft.listApprovals(ACCOUNT, 4441)), []);
  assert.deepEqual(nft.probes, [`${TOKEN.toLowerCase()}:${approveAmount.ERC721_INTERFACE_ID}`]);
  // Another target answers false: an ERC-20 approve is recorded.
  await note(OTHER, approveData(SPENDER, 7n));
  assert.deepEqual(plain(await nft.listApprovals(ACCOUNT, 4441)).map((row) => row.token), [OTHER.toLowerCase()]);
  // increaseAllowance is ERC-20 only: no probe.
  await note(TOKEN, approveData(SPENDER, 1n, approveAmount.INCREASE_ALLOWANCE_SELECTOR));
  assert.equal(nft.probes.length, 2);
  // An RPC that never answers the probe still records the approve (the list guards Revoke).
  const down = loadApprovals(fakeStore(), () => Promise.reject(new Error("timeout")));
  await down.noteSignedApproval(ACCOUNT, NETWORK as never, HASH, { to: TOKEN as `0x${string}`, data: approveData(SPENDER, 1n), chainId: 4441 });
  assert.equal(plain(await down.listApprovals(ACCOUNT, 4441)).length, 1);
});

test("garbage, __proto__ keys and bad rows read as nothing", async () => {
  const { parseApprovals, listApprovals, store } = loadApprovals();
  for (const junk of [null, 7, "x", [], { [ACCOUNT]: "x" }]) assert.deepEqual(plain(parseApprovals(junk)), {});
  const good = { token: TOKEN.toLowerCase(), spender: SPENDER.toLowerCase(), hash: HASH, at: 5 };
  const parsed = parseApprovals(JSON.parse(JSON.stringify({
    [ACCOUNT.toLowerCase()]: {
      4441: [good, { ...good, token: "0x12" }, { ...good, spender: SPENDER }, { ...good, hash: "0x1" },
        { ...good, at: -1 }, { ...good, at: 1.5 }, null, "row"],
      "0": [good],
      "01": [good],
      "__proto__": [good],
    },
    [ACCOUNT]: { 4441: [good] },
    "__proto__": { 4441: [good] },
  })));
  assert.deepEqual(plain(parsed), { [ACCOUNT.toLowerCase()]: { 4441: [good] } });
  assert.equal(({} as Record<string, unknown>)["4441"], undefined);
  // A record the store cannot even parse reads as empty, never as an error.
  store.map.set(STORAGE_KEYS.approvals, "{\"broken\"");
  assert.deepEqual(plain(await listApprovals(ACCOUNT, 4441)), []);
  store.map.set(STORAGE_KEYS.approvals, JSON.stringify([1, 2]));
  assert.deepEqual(plain(await listApprovals(ACCOUNT, 4441)), []);
});

test("transfer, setApprovalForAll and permits are never recorded", async () => {
  const approvals = loadApprovals();
  const transfer = `0xa9059cbb${word(SPENDER)}${word("1")}` as const;
  const approvalForAll = `0xa22cb465${word(SPENDER)}${word("1")}` as const;
  for (const data of [transfer, approvalForAll, undefined, "0x" as const, approveData(SPENDER, 1n).slice(0, 100) as `0x${string}`]) {
    await approvals.noteSignedApproval(ACCOUNT, NETWORK as never, HASH, { to: TOKEN as `0x${string}`, data, chainId: 4441 });
  }
  // A contract creation has no target.
  await approvals.noteSignedApproval(ACCOUNT, NETWORK as never, HASH, { data: approveData(SPENDER, 1n), chainId: 4441 });
  assert.equal(approvals.store.map.size, 0);
  // Permits are typed-data signatures: they never reach the transaction signer's hook.
  const tx = readFileSync(new URL("../../src/core/services/tx.ts", import.meta.url), "utf8");
  assert.match(tx, /written = record\(hash\);\n\s+\/\/ Token approvals[^\n]*\n[^\n]*\n\s+try \{ void noteSignedApproval\(from, network, hash, call\)\.catch\(\(\) => \{\}\); \} catch/u);
  const client = readFileSync(new URL("../../src/core/rpc/client.ts", import.meta.url), "utf8");
  assert.equal(client.match(/noteSignedApproval|onSigned\?\.\(/gu)?.length, 1, "only signTransaction reports a signed call");
});

test("past 16 chains the ones with the newest records are kept, whatever their ids", async () => {
  const approvals = loadApprovals();
  // Larger ids recorded later: integer-like keys would enumerate the smallest first.
  for (let index = 0; index < 17; index += 1) {
    const chainId = 100 + index;
    await approvals.noteSignedApproval(ACCOUNT, { ...NETWORK, chainId } as never, HASH, {
      to: TOKEN as `0x${string}`, data: approveData(SPENDER, 1n), chainId,
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const book = plain(await approvals.listApprovalBook(ACCOUNT));
  const chains = Object.keys(book).map(Number).sort((a, b) => a - b);
  assert.equal(chains.length, 16);
  assert.equal(chains.includes(116), true, "the chain recorded last is kept");
  assert.equal(chains.includes(100), false, "the least recently used chain goes");
});
