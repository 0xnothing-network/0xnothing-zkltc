import assert from "node:assert/strict";
import test from "node:test";
import { toAccount, type LocalAccount } from "viem/accounts";
import { evaluateModule } from "../../../web/tests/helpers/evaluateModule.ts";

const owner = `0x${"11".repeat(20)}` as const;
const other = `0x${"22".repeat(20)}` as const;
const signature = `0x${"33".repeat(65)}` as const;

function fixture() {
  const network = { id: "litvm", chainId: 4441, rpcUrl: "https://rpc.example" };
  let selected: string = owner;
  let savedNetwork = network;
  let unlocked = true;
  let signatures = 0;
  let keyReads = 0;
  class WalletLockedError extends Error { constructor() { super("Wallet locked"); } }
  const sign = async () => { signatures += 1; return signature; };
  const module = evaluateModule<{
    walletClientFor(address: string): Promise<{ account: LocalAccount }>;
    configureRpcClient(profile: typeof network): void;
  }>(new URL("../../src/core/rpc/client.ts", import.meta.url), {
    viem: { createPublicClient: () => ({}), createWalletClient: (options: unknown) => options, http: () => ({}) },
    "viem/accounts": { toAccount },
    "../../config/networks": {
      LITVM_NETWORK: network,
      networkIdentity: (n: typeof network) => `${n.id}:${n.chainId}:${n.rpcUrl}`,
      resolveNetwork: () => savedNetwork,
      viemChainFor: () => ({ id: 4441 }),
    },
    "../i18n": { t: () => "Review this transaction again" },
    "../keyring/vault": {
      WalletLockedError,
      signerFor: async () => {
        keyReads += 1;
        if (!unlocked) throw new WalletLockedError();
        return { address: owner, sign, signAuthorization: sign, signTransaction: sign, signMessage: sign, signTypedData: sign };
      },
      readAccounts: async () => ({ active: selected, accounts: [] }),
      readSettings: async () => ({ networkId: savedNetwork.id, customNetworks: [savedNetwork] }),
      isUnlocked: async () => unlocked,
    },
  });
  return {
    ...module,
    lock: () => { unlocked = false; },
    selectAccount: () => { selected = other; },
    switchRpc: () => {
      savedNetwork = { ...network, rpcUrl: "https://changed.example" };
      module.configureRpcClient(savedNetwork);
    },
    changeStoredRpc: () => { savedNetwork = { ...network, rpcUrl: "https://changed.example" }; },
    signatures: () => signatures,
    keyReads: () => keyReads,
  };
}

const requests: Array<(account: LocalAccount) => Promise<unknown>> = [
  (account) => account.sign!({ hash: `0x${"44".repeat(32)}` }),
  (account) => account.signAuthorization!({ contractAddress: other, chainId: 4441, nonce: 0 }),
  (account) => account.signMessage({ message: "reviewed message" }),
  (account) => account.signTransaction({ to: other, value: 1n, chainId: 4441 }),
  (account) => account.signTypedData({ domain: {}, types: { Message: [{ name: "value", type: "uint256" }] }, primaryType: "Message", message: { value: 1n } }),
];

test("clients created before locking cannot sign through any account entry point", async () => {
  for (const request of requests) {
    const run = fixture();
    const client = await run.walletClientFor(owner);
    run.lock();
    await assert.rejects(request(client.account), /locked/);
    assert.equal(run.signatures(), 0);
  }
});

test("account or RPC changes during transaction preparation invalidate the signer", async () => {
  for (const change of ["selectAccount", "switchRpc"] as const) {
    const run = fixture();
    const client = await run.walletClientFor(owner);
    run[change]();
    await assert.rejects(client.account.signTransaction({ to: other, value: 1n, chainId: 4441 }), /Review/);
    assert.equal(run.signatures(), 0);
  }
});

test("each authorized signature resolves a fresh signer and keeps account secrets out of the client", async () => {
  const run = fixture();
  const client = await run.walletClientFor(owner);
  assert.equal(client.account.source, "custom");
  for (const request of requests) assert.equal(await request(client.account), signature);
  assert.equal(run.signatures(), requests.length);
  assert.equal(run.keyReads(), requests.length + 1);
});

test("a persisted network change invalidates signatures before the UI finishes reloading its RPC client", async () => {
  for (const request of requests) {
    const run = fixture();
    const client = await run.walletClientFor(owner);
    run.changeStoredRpc();
    await assert.rejects(request(client.account), /Review/);
    assert.equal(run.signatures(), 0);
  }
});
