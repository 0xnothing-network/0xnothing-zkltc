import assert from "node:assert/strict";
import test from "node:test";
import { toAccount, type LocalAccount } from "viem/accounts";
import { isHex } from "viem";
import { evaluateModule } from "../../../web/tests/helpers/evaluateModule.ts";
import { type DappRequest } from "../../src/core/services/dapp.ts";

const owner = `0x${"11".repeat(20)}` as const;
const other = `0x${"22".repeat(20)}` as const;
const signature = `0x${"33".repeat(65)}` as const;
const claim = "12345678-1234-4123-8123-123456789abc";

function fixture(kind: DappRequest["kind"] = "sign") {
  const network = { id: "litvm", chainId: 4441, rpcUrl: "https://rpc.example" };
  let selectedNetwork = network;
  let selectedAccount: string = owner;
  let unlocked = true;
  let connected = true;
  let claimed = true;
  let signatures = 0;
  let releaseKey: (() => void) | undefined;
  const keyWait = new Promise<void>((resolve) => { releaseKey = resolve; });
  let holdingKey = false;
  class WalletLockedError extends Error { constructor() { super("Wallet locked"); } }
  const sign = async () => { signatures += 1; return signature; };
  const vault = {
    WalletLockedError,
    signerFor: async () => {
      if (!unlocked) throw new WalletLockedError();
      holdingKey = true;
      await keyWait;
      return { address: owner, sign, signAuthorization: sign, signTransaction: sign, signMessage: sign, signTypedData: sign };
    },
    readAccounts: async () => ({ active: selectedAccount, accounts: [] }),
    isUnlocked: async () => unlocked,
    readSettings: async () => ({ networkId: selectedNetwork.id, customNetworks: [selectedNetwork] }),
  };
  const networks = {
    LITVM_NETWORK: network,
    networkIdentity: (n: typeof network) => `${n.id}:${n.chainId}:${n.rpcUrl}`,
    resolveNetwork: () => selectedNetwork,
    viemChainFor: () => ({ id: 4441 }),
  };
  const rpc = evaluateModule<{
    walletClientFor(address: string, profile: typeof network, guard?: () => Promise<void>): Promise<unknown>;
    publicClientFor(profile: typeof network): unknown;
    configureRpcClient(profile: typeof network): void;
  }>(new URL("../../src/core/rpc/client.ts", import.meta.url), {
    viem: {
      createPublicClient: () => ({}),
      createWalletClient: (options: { account: LocalAccount }) => ({
        ...options,
        signMessage: (params: Parameters<LocalAccount["signMessage"]>[0]) => options.account.signMessage(params),
        signTypedData: (params: Parameters<LocalAccount["signTypedData"]>[0]) => options.account.signTypedData(params),
      }),
      http: () => ({}),
    },
    "viem/accounts": { toAccount },
    "../../config/networks": networks,
    "../i18n": { t: () => "Review this transaction again" },
    "../keyring/vault": vault,
  });
  const request: DappRequest = {
    id: "reviewed-request", origin: "https://dapp.example", at: Date.now(), kind,
    networkId: network.id, account: owner,
    message: kind === "sign-typed" ? JSON.stringify({
      domain: { chainId: 4441 }, types: { Message: [{ name: "value", type: "uint256" }] },
      primaryType: "Message", message: { value: "1" },
    }) : "reviewed message",
    tx: kind === "transaction" ? { to: other, value: "0x1" } : undefined,
    targetNetworkId: kind === "switch-network" ? "other-network" : undefined,
  };
  const dapp = {
    DAPP_REQUEST_TIMEOUT_MS: 240_000,
    connectedAccounts: async () => connected ? [owner] : [],
    listPending: async () => claimed ? [{ ...request, approvalClaim: claim }] : [],
  };
  const module = evaluateModule<{
    executeDappRequest(request: DappRequest, signer: string, host: string, profile: typeof network, approvalClaim: string): Promise<string>;
  }>(new URL("../../src/core/services/dappExecution.ts", import.meta.url), {
    viem: { isHex },
    "../../config/networks": networks,
    "../i18n": { t: () => "Review this transaction again" },
    "../keyring/vault": vault,
    "../rpc/client": rpc,
    "./dapp": dapp,
    "./tx": {
      sendRaw: async (_params: unknown, context?: { assertReady?: () => Promise<void> }) => {
        const client = await rpc.walletClientFor(owner, network, context?.assertReady) as { account: LocalAccount };
        await client.account.signTransaction({ to: other, value: 1n, chainId: 4441 });
        return signature;
      },
    },
  });
  return {
    run: () => module.executeDappRequest(request, owner, "dapp.example", network, claim),
    request,
    release: () => releaseKey!(),
    signatures: () => signatures,
    waitForKey: async () => {
      for (let i = 0; i < 50 && !holdingKey; i += 1) await Promise.resolve();
      assert.equal(holdingKey, true, "execution reached asynchronous key retrieval");
    },
    lock: () => { unlocked = false; },
    selectAccount: () => { selectedAccount = other; },
    switchRpc: () => {
      selectedNetwork = { ...network, rpcUrl: "https://other.example" };
      rpc.configureRpcClient(selectedNetwork);
    },
    changeStoredRpc: () => { selectedNetwork = { ...network, rpcUrl: "https://other.example" }; },
    revoke: () => { connected = false; },
    removeClaim: () => { claimed = false; },
  };
}

test("dapp signatures recheck account, network, lock, permission and claim after asynchronous key retrieval", async () => {
  for (const kind of ["sign", "sign-typed", "transaction"] as const) {
    for (const change of ["lock", "selectAccount", "switchRpc", "changeStoredRpc", "revoke", "removeClaim"] as const) {
      const run = fixture(kind);
      const pending = run.run();
      await run.waitForKey();
      run[change]();
      run.release();
      await assert.rejects(pending, /locked|Review/);
      assert.equal(run.signatures(), 0, `${kind}: ${change}`);
    }
  }
});

test("an unchanged claimed request signs successfully", async () => {
  for (const kind of ["sign", "sign-typed", "transaction"] as const) {
    const run = fixture(kind);
    run.release();
    assert.equal(await run.run(), signature);
    assert.equal(run.signatures(), 1);
  }
});

test("connect and network-change approvals fail after account changes or lost claim", async () => {
  for (const kind of ["connect", "switch-network"] as const) {
    for (const change of ["selectAccount", "removeClaim", "changeStoredRpc"] as const) {
      const run = fixture(kind);
      run[change]();
      run.release();
      await assert.rejects(run.run(), /Review/);
    }
  }
});

test("expired or differently reviewed network requests cannot execute", async () => {
  for (const change of ["expired", "network-identity"] as const) {
    const run = fixture();
    if (change === "expired") run.request.at -= 240_001;
    else run.request.networkIdentity = "previous RPC profile";
    run.release();
    await assert.rejects(run.run(), /Review/);
    assert.equal(run.signatures(), 0);
  }
});

test("typed data for a different chain is refused by execution even without UI validation", async () => {
  const run = fixture("sign-typed");
  run.request.message = JSON.stringify({ domain: { chainId: 1 } });
  run.release();
  await assert.rejects(run.run(), /Review/);
  assert.equal(run.signatures(), 0);
});
