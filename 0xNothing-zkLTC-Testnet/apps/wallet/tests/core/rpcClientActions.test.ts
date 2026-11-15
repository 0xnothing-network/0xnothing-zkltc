import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateModule } from "../../../web/tests/helpers/evaluateModule.ts";

/**
 * O2: the clients are viem's bare createClient plus only the actions the wallet
 * calls, bound the way createPublicClient / createWalletClient bound them
 * (`name: (args) => action(client, args)`). Measured: 105 KB less built JS.
 */
const READ = [
  "estimateContractGas", "estimateFeesPerGas", "estimateGas", "getBalance", "getBlock", "getBlockNumber",
  "getChainId", "getGasPrice", "getTransaction", "getTransactionCount", "getTransactionReceipt", "multicall",
  "readContract", "simulateContract", "waitForTransactionReceipt",
];
const SIGN = ["sendTransaction", "signMessage", "signTypedData", "writeContract"];
const owner = `0x${"11".repeat(20)}`;

function fixture() {
  const calls: { action: string; client: unknown; args: unknown }[] = [];
  const actions = Object.fromEntries([...READ, ...SIGN].map((name) => [
    name,
    (client: unknown, args: unknown) => {
      calls.push({ action: name, client, args });
      return `${name}-result`;
    },
  ]));
  type Built = { options: Record<string, unknown>; extended: Record<string, (args?: unknown) => unknown> };
  const built: Built[] = [];
  const network = { id: "litvm", builtin: true, rpcUrl: "https://rpc.invalid" };
  const rpc = evaluateModule<{
    publicClient: Record<string, (args?: unknown) => unknown>;
    walletClientFor(address: string): Promise<Record<string, (args?: unknown) => unknown>>;
  }>(new URL("../../src/core/rpc/client.ts", import.meta.url), {
    viem: {
      createClient: (options: Record<string, unknown>) => {
        const client = { ...options };
        return {
          extend: (decorate: (c: unknown) => Record<string, (args?: unknown) => unknown>) => {
            const extended = { ...client, ...decorate(client) } as Built["extended"];
            built.push({ options, extended });
            return extended;
          },
        };
      },
      fallback: (transports: unknown[]) => ({ fallback: transports }),
      http: (url: string) => ({ url }),
      keccak256: () => "0x",
    },
    "viem/actions": actions,
    "viem/accounts": { toAccount: (source: unknown) => source },
    "../i18n": { t: (key: string) => key },
    "../../config/networks": {
      LITVM_NETWORK: network,
      networkIdentity: () => "litvm",
      resolveNetwork: () => network,
      viemChainFor: () => ({ id: 4441 }),
    },
    "../keyring/vault": {
      signerFor: async () => ({ address: owner }),
      readAccounts: async () => ({ active: owner, accounts: [] }),
      readSettings: async () => ({ networkId: "litvm", customNetworks: [] }),
      isUnlocked: async () => true,
    },
    "../services/rpcProbe": { probeChainId: async () => null },
  });
  return { rpc, calls, built };
}

test("the read client carries the public client's identity, options and exactly the read actions", () => {
  const { rpc, calls, built } = fixture();
  const read = built[0]!;
  assert.equal(read.options.key, "public");
  assert.equal(read.options.name, "Public Client");
  assert.equal(read.options.type, "publicClient");
  assert.equal(read.options.ccipRead, false);
  assert.equal(JSON.stringify(read.options.batch), JSON.stringify({ multicall: { batchSize: 16_384 } }));
  assert.deepEqual(Object.keys(rpc.publicClient).filter((key) => typeof rpc.publicClient[key] === "function").sort(), [...READ].sort());
  for (const name of READ) {
    const args = { probe: name };
    assert.equal(rpc.publicClient[name]!(args), `${name}-result`);
    const call = calls.at(-1)!;
    assert.equal(call.action, name);
    // The bare client itself (not the decorated one), as viem's publicActions pass it.
    assert.equal((call.client as { type: string }).type, "publicClient");
    assert.equal(call.args, name === "getChainId" || name === "getGasPrice" ? undefined : args, name);
  }
});

test("the signing client carries the wallet client's identity and exactly the signing actions", async () => {
  const { rpc, calls, built } = fixture();
  const signer = await rpc.walletClientFor(owner);
  const sign = built.at(-1)!;
  assert.equal(sign.options.key, "wallet");
  assert.equal(sign.options.name, "Wallet Client");
  assert.equal(sign.options.type, "walletClient");
  assert.equal(sign.options.ccipRead, false);
  assert.equal((sign.options.account as { address: string }).address, owner);
  assert.deepEqual(Object.keys(signer).filter((key) => typeof signer[key] === "function").sort(), [...SIGN].sort());
  for (const name of SIGN) {
    const args = { probe: name };
    assert.equal(signer[name]!(args), `${name}-result`);
    assert.equal(calls.at(-1)!.action, name);
    assert.equal(calls.at(-1)!.args, args);
    assert.equal((calls.at(-1)!.client as { type: string }).type, "walletClient");
  }
});

test("no whole-client constructor is imported again", () => {
  const source = readFileSync(new URL("../../src/core/rpc/client.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bcreate(Public|Wallet)Client\(|\b(public|wallet)Actions\)/u);
  assert.doesNotMatch(source, /import \{[^}]*\b(createPublicClient|createWalletClient|publicActions|walletActions)\b[^}]*\} from "viem"/u);
  assert.match(source, /\}\)\.extend\(readActions\);/u);
  assert.match(source, /\}\)\.extend\(signActions\);/u);
});
