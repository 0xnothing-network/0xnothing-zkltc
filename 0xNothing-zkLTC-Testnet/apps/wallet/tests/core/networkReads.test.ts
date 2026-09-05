import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Run the real service code with controlled storage/RPC promises. No signing,
// browser storage, or external requests are involved in these regressions.
function evaluate<T>(path: string, imports: Record<string, unknown>): T {
  const file = new URL(path, import.meta.url);
  const code = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: file.pathname,
  }).outputText;
  const exports = {};
  runInNewContext(code, {
    exports,
    require(name: string) {
      if (!Object.hasOwn(imports, name)) throw new Error(`Unexpected import: ${name}`);
      return imports[name];
    },
  });
  return exports as T;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const owner = `0x${"11".repeat(20)}`;
const hash = `0x${"22".repeat(32)}`;
const originalNetwork = { id: "litvm", builtin: true };
const otherNetwork = { id: "other", builtin: false };
const unlocked = (_name: string, action: () => unknown) => action();

test("profile read clients reuse the active RPC and resolve other profiles without selecting them", () => {
  const original = { ...originalNetwork, rpcUrl: "https://original.invalid" };
  const other = { ...original, rpcUrl: "https://other.invalid" };
  type Client = { transport: string };
  const rpc = evaluate<{
    publicClient: Client;
    activeNetwork: typeof original;
    publicClientFor(network: typeof original): Client;
    configureRpcClient(network: typeof original): void;
  }>("../../src/core/rpc/client.ts", {
    viem: {
      createPublicClient: (options: Client) => options,
      createWalletClient: () => ({}),
      http: (url: string) => url,
    },
    "../../config/networks": {
      LITVM_NETWORK: original,
      networkIdentity: (network: typeof original) => `${network.id}:${network.rpcUrl}`,
      viemChainFor: (network: typeof original) => ({ id: network.id }),
    },
    "../keyring/vault": {},
  });
  const first = rpc.publicClient;
  assert.equal(rpc.publicClientFor(original), first);
  assert.equal(rpc.publicClientFor(other).transport, other.rpcUrl);
  assert.equal(rpc.activeNetwork, original);
  assert.equal(rpc.publicClient, first);
  rpc.configureRpcClient(other);
  assert.equal(rpc.publicClientFor(other), rpc.publicClient);
  assert.equal(rpc.publicClientFor(original).transport, original.rpcUrl);
  assert.equal(rpc.activeNetwork, other);
});

interface RecordRow {
  hash: string;
  account: string;
  networkId?: string;
  status: string;
  kind: string;
  at: number;
}

interface HistoryService {
  addRecord(record: RecordRow): Promise<void>;
  listRecords(account: string, network: { id: string }): Promise<RecordRow[]>;
  listSettled(account: string, network?: { id: string }): Promise<RecordRow[]>;
}

function historyFixture(rows: RecordRow[] = []) {
  let book = { [owner]: rows };
  const storage = {
    get: async () => book,
    set: async (_key: string, value: typeof book) => { book = value; },
  };
  const calls: string[] = [];
  const oldClient = {
    getTransactionReceipt: async () => { calls.push("original"); return { status: "success" }; },
  };
  const newClient = {
    getTransactionReceipt: async () => { calls.push("other"); return { status: "reverted" }; },
  };
  const rpc = {
    activeNetwork: originalNetwork,
    publicClient: oldClient,
    publicClientFor: (network: { id: string }) => network.id === originalNetwork.id ? oldClient : newClient,
  };
  const service = evaluate<HistoryService>("../../src/core/services/history.ts", {
    "../i18n": { t: (key: string) => key },
    "../../config/networks": { LITVM_NETWORK: originalNetwork },
    "../platform/storage": { persistentStore: storage },
    "../platform/storageKeys": { STORAGE_KEYS: { history: "history" } },
    "../platform/locks": { withNamedLock: unlocked },
    "../rpc/client": rpc,
  });
  return { service, storage, calls, rpc, newClient };
}

const pending = (): RecordRow => ({ hash, account: owner, kind: "send", status: "pending", at: 1 });

test("receipt settlement keeps its network when storage yields across a profile switch", async () => {
  const fixture = historyFixture([pending()]);
  const read = deferred<{ [key: string]: RecordRow[] }>();
  const previousGet = fixture.storage.get;
  fixture.storage.get = () => read.promise;
  const result = fixture.service.listSettled(owner);
  fixture.rpc.activeNetwork = otherNetwork;
  fixture.rpc.publicClient = fixture.newClient;
  fixture.storage.get = previousGet;
  read.resolve({ [owner]: [pending()] });
  assert.equal((await result)[0]?.status, "success");
  assert.deepEqual(fixture.calls, ["original"]);
  assert.equal((await fixture.service.listRecords(owner, originalNetwork))[0]?.status, "success");
});

test("explicit history profiles are settled on that profile's RPC", async () => {
  const fixture = historyFixture([pending()]);
  fixture.rpc.activeNetwork = otherNetwork;
  fixture.rpc.publicClient = fixture.newClient;
  assert.equal((await fixture.service.listSettled(owner, originalNetwork))[0]?.status, "success");
  assert.deepEqual(fixture.calls, ["original"]);
});

test("history deduplicates a hash within one network without erasing another profile", async () => {
  const fixture = historyFixture([pending()]);
  await fixture.service.addRecord({ ...pending(), networkId: otherNetwork.id, at: 2 });
  assert.equal((await fixture.service.listRecords(owner, originalNetwork)).length, 1);
  assert.equal((await fixture.service.listRecords(owner, otherNetwork)).length, 1);
  await fixture.service.addRecord({ ...pending(), networkId: originalNetwork.id, status: "success", at: 3 });
  const original = await fixture.service.listRecords(owner, originalNetwork);
  assert.equal(original.length, 1);
  assert.equal(original[0]?.at, 3);
  assert.equal((await fixture.service.listRecords(owner, otherNetwork)).length, 1);
});

interface TxService {
  previewRaw(params: { from: string }): Promise<{ gas: bigint; feeWei: bigint }>;
  ensureAllowance(params: { from: string; token: string; spender: string; amount: bigint; symbol: string }): Promise<string | null>;
}

function txFixture() {
  const calls: string[] = [];
  const fees = deferred<{ maxFeePerGas: bigint }>();
  const allowance = deferred<bigint>();
  const client = {
    estimateFeesPerGas: () => fees.promise,
    getGasPrice: async () => { calls.push("original-price"); return 3n; },
    estimateGas: async () => { calls.push("original-gas"); return 100n; },
    readContract: () => allowance.promise,
    simulateContract: async () => { calls.push("original-simulate"); return { request: {} }; },
    waitForTransactionReceipt: async () => ({ status: "success" }),
  };
  const otherClient = {
    ...client,
    getGasPrice: async () => { calls.push("other-price"); return 30n; },
    estimateGas: async () => { calls.push("other-gas"); return 1_000n; },
    simulateContract: async () => { calls.push("other-simulate"); return { request: {} }; },
  };
  const rpc = {
    activeNetwork: originalNetwork,
    publicClient: client,
    walletClientFor: async (_address: string, network: { id: string }) => {
      calls.push(`signer:${network.id}`);
      return { account: owner, writeContract: async () => hash };
    },
  };
  const service = evaluate<TxService>("../../src/core/services/tx.ts", {
    "../../abis": { erc20Abi: [] },
    "../i18n": { t: (key: string) => key },
    "../keyring/vault": { touchSession: async () => {} },
    "../lib/errors": { describeError: String },
    "../platform/locks": { withNamedLock: unlocked },
    "../rpc/client": rpc,
    "./history": { addRecord: async () => {}, setRecordStatus: async () => {} },
  });
  const switchNetwork = () => { rpc.activeNetwork = otherNetwork; rpc.publicClient = otherClient; };
  return { service, calls, fees, allowance, switchNetwork };
}

test("gas previews do not combine fee and gas reads from different networks", async () => {
  const fixture = txFixture();
  const result = fixture.service.previewRaw({ from: owner });
  fixture.switchNetwork();
  fixture.fees.resolve({ maxFeePerGas: 3n });
  assert.equal((await result).feeWei, 360n);
  assert.deepEqual(fixture.calls, ["original-gas"]);
});

test("legacy gas-price fallback stays on the preview's original network", async () => {
  const fixture = txFixture();
  const result = fixture.service.previewRaw({ from: owner });
  fixture.switchNetwork();
  fixture.fees.reject(new Error("EIP-1559 unavailable"));
  assert.equal((await result).feeWei, 360n);
  assert.deepEqual(fixture.calls, ["original-price", "original-gas"]);
});

test("allowance reads and approvals share a pinned context when none is supplied", async () => {
  const fixture = txFixture();
  const result = fixture.service.ensureAllowance({ from: owner, token: owner, spender: owner, amount: 10n, symbol: "T" });
  fixture.switchNetwork();
  fixture.allowance.resolve(0n);
  assert.equal(await result, hash);
  assert.deepEqual(fixture.calls, ["signer:litvm", "original-simulate"]);
});

test("an existing sufficient allowance still avoids signing a transaction", async () => {
  const fixture = txFixture();
  const result = fixture.service.ensureAllowance({ from: owner, token: owner, spender: owner, amount: 10n, symbol: "T" });
  fixture.switchNetwork();
  fixture.allowance.resolve(10n);
  assert.equal(await result, null);
  assert.equal(fixture.calls.length, 0);
});

interface NftService {
  loadPixelNfts(owner: string): Promise<{ tokenId: bigint; name: string }[]>;
}

function nftFixture() {
  const balance = deferred<bigint>();
  const calls: string[] = [];
  const tokenData = ["Pixel", 8n, "pixels", owner, 1n, "0x"];
  const client = {
    readContract: () => balance.promise,
    multicall: async ({ contracts }: { contracts: { functionName: string }[] }): Promise<(
      { status: "success"; result: unknown } | { status: "failure"; error: Error }
    )[]> => {
      const first = contracts[0];
      assert.ok(first);
      const functionName = first.functionName;
      calls.push(functionName);
      return contracts.map(() => ({ status: "success", result: functionName === "userTokens" ? 1n : tokenData }));
    },
  };
  const otherClient = {
    ...client,
    multicall: async () => { throw new Error("wrong network"); },
  };
  const rpc = { activeNetwork: originalNetwork, publicClient: client };
  const service = evaluate<NftService>("../../src/core/services/nfts.ts", {
    "../../abis": { pixelNftAbi: [] },
    "../../config/contracts": { CONTRACTS: { pixelNft: owner } },
    "../lib/pixelSvg": { pixelDataToSvgDataUrl: () => "data:image/svg+xml,test" },
    "../rpc/client": rpc,
    "./tx": {},
  });
  return { service, balance, client, rpc, otherClient, calls };
}

test("NFT enumeration keeps all RPC waves on the network selected at start", async () => {
  const fixture = nftFixture();
  const result = fixture.service.loadPixelNfts(owner);
  fixture.rpc.activeNetwork = otherNetwork;
  fixture.rpc.publicClient = fixture.otherClient;
  fixture.balance.resolve(1n);
  assert.equal((await result)[0]?.tokenId, 1n);
  assert.deepEqual(fixture.calls, ["userTokens", "tokenData"]);
});

test("an NFT balance RPC failure rejects instead of publishing an empty wallet", async () => {
  const fixture = nftFixture();
  const result = fixture.service.loadPixelNfts(owner);
  fixture.balance.reject(new Error("RPC unavailable"));
  await assert.rejects(result, /RPC unavailable/u);
});

for (const stage of ["userTokens", "tokenData"]) {
  test(`a failed ${stage} read cannot publish a partial NFT snapshot`, async () => {
    const fixture = nftFixture();
    const multicall = fixture.client.multicall;
    fixture.client.multicall = async (params) => params.contracts[0]?.functionName === stage
      ? params.contracts.map(() => ({ status: "failure", error: new Error("RPC unavailable") }))
      : multicall(params);
    const result = fixture.service.loadPixelNfts(owner);
    fixture.balance.resolve(1n);
    await assert.rejects(result, /RPC unavailable/u);
  });
}

test("a verified zero NFT balance still returns an empty list", async () => {
  const fixture = nftFixture();
  const result = fixture.service.loadPixelNfts(owner);
  fixture.balance.resolve(0n);
  assert.equal((await result).length, 0);
  assert.equal(fixture.calls.length, 0);
});
