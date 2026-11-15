import assert from "node:assert/strict";
import test from "node:test";
import { toAccount, type LocalAccount } from "viem/accounts";
import { encodeFunctionData, erc20Abi, isHex } from "viem";
import * as approveAmount from "../../src/core/lib/approveAmount.ts";
import { evaluateModule } from "../../../web/tests/helpers/evaluateModule.ts";
import { type DappRequest } from "../../src/core/services/dapp.ts";
import { withCreateClient } from "../helpers/viemClients.ts";

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
  // What reached sendRaw (F18: the spending-cap override).
  const sent: Array<{ to?: string; value?: bigint; data?: string; gas?: bigint }> = [];
  // watch-asset and add-network (F5, F11): what was written, and what the chain answers.
  const tokenWrites: Array<{ address: string; networkId: string; expected: unknown }> = [];
  const networkWrites: Array<{ candidate: { chainId: number }; options: { select: boolean } }> = [];
  const savedChains = new Set<number>();
  let tokenAlreadyAdded = false;
  let tokenChanged = false;
  let probeAnswer: bigint | null = 8453n;
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
    addCustomNetwork: async (candidate: { chainId: number }, options: { select: boolean }) => {
      networkWrites.push({ candidate, options });
      return savedChains.has(candidate.chainId) ? "exists" : "added";
    },
  };
  const networks = {
    LITVM_NETWORK: network,
    networkIdentity: (n: typeof network) => `${n.id}:${n.chainId}:${n.rpcUrl}`,
    resolveNetwork: () => selectedNetwork,
    viemChainFor: () => ({ id: 4441 }),
    sanitizeCustomNetwork: (input: Record<string, unknown>) => ({ ...input, id: "custom-8453-test", builtin: false }),
  };
  // Key-aware so the execution's own comparisons (err.tokenAdded) can be exercised.
  const i18n = {
    t: (key: string) => key === "err.tokenAdded" ? "That token is already on the list"
      : key === "apr.addNetworkMismatch" ? "The RPC answers another chain"
      : key === "apr.watchAssetChanged" ? "The token's details changed"
      : "Review this transaction again",
  };
  const rpc = evaluateModule<{
    walletClientFor(address: string, profile: typeof network, guard?: () => Promise<void>): Promise<unknown>;
    publicClientFor(profile: typeof network): unknown;
    configureRpcClient(profile: typeof network): void;
  }>(new URL("../../src/core/rpc/client.ts", import.meta.url), {
    viem: withCreateClient({
      createPublicClient: () => ({}),
      createWalletClient: (options: { account: LocalAccount }) => ({
        ...options,
        signMessage: (params: Parameters<LocalAccount["signMessage"]>[0]) => options.account.signMessage(params),
        signTypedData: (params: Parameters<LocalAccount["signTypedData"]>[0]) => options.account.signTypedData(params),
      }),
      http: () => ({}),
    }),
    "viem/actions": {},
    "viem/accounts": { toAccount },
    "../../config/networks": networks,
    "../i18n": { t: () => "Review this transaction again" },
    "../keyring/vault": vault,
    "../services/rpcProbe": { probeChainId: async () => null },
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
    asset: kind === "watch-asset" ? { address: `0x${"44".repeat(20)}`, symbol: "PAGE", decimals: 6 } : undefined,
    chain: kind === "add-network" ? {
      chainId: 8453, name: "Base", currencyName: "Ether", symbol: "ETH", decimals: 18,
      rpcUrl: "https://mainnet.base.org/", explorerUrl: "https://basescan.org",
    } : undefined,
  };
  const dapp = {
    DAPP_REQUEST_TIMEOUT_MS: 240_000,
    DAPP_SIGN_RESERVE_MS: 40_000,
    connectedAccounts: async () => connected ? [owner] : [],
    listPending: async () => claimed ? [{ ...request, approvalClaim: claim }] : [],
  };
  const module = evaluateModule<{
    executeDappRequest(
      request: DappRequest, signer: string, host: string, profile: typeof network, approvalClaim: string,
      onSigned?: (hash: string) => void, shownToken?: unknown, override?: { data?: string },
    ): Promise<string>;
  }>(new URL("../../src/core/services/dappExecution.ts", import.meta.url), {
    viem: { isHex },
    "../../config/networks": networks,
    "../i18n": i18n,
    "../lib/approveAmount": approveAmount,
    "../keyring/vault": vault,
    "../rpc/client": rpc,
    "./dapp": dapp,
    "./rpcProbe": { probeChainId: async () => probeAnswer },
    "./tokens": {
      addCustomToken: async (address: string, profile: typeof network, expected: unknown) => {
        if (tokenAlreadyAdded) throw new Error("That token is already on the list");
        if (tokenChanged) throw new Error("The token's details changed");
        tokenWrites.push({ address, networkId: profile.id, expected });
        return [];
      },
    },
    "./tx": {
      // Like tx.ts: onSigned fires once the transaction is signed, before the broadcast.
      sendRaw: async (params: { to?: string; value?: bigint; data?: string; gas?: bigint }, context?: { assertReady?: () => Promise<void>; onSigned?: (hash: string) => void }) => {
        sent.push({ to: params.to, value: params.value, data: params.data, gas: params.gas });
        const client = await rpc.walletClientFor(owner, network, context?.assertReady) as { account: LocalAccount };
        await client.account.signTransaction({ to: other, value: 1n, chainId: 4441 });
        context?.onSigned?.(signature);
        return signature;
      },
    },
  });
  const told: string[] = [];
  const shown = { symbol: "TKN", name: "Token", decimals: 18 };
  return {
    run: () => module.executeDappRequest(
      request, owner, "dapp.example", network, claim, (hash) => { told.push(hash); },
      ...(kind === "watch-asset" ? [shown] : []) as [],
    ),
    runWith: (override: { data?: string }) => module.executeDappRequest(
      request, owner, "dapp.example", network, claim, (hash) => { told.push(hash); }, undefined, override,
    ),
    sent,
    shown,
    tokenWrites,
    networkWrites,
    saveChain: (chainId: number) => { savedChains.add(chainId); },
    tokenAlreadyAdded: () => { tokenAlreadyAdded = true; },
    tokenChanged: () => { tokenChanged = true; },
    probe: (answer: bigint | null) => { probeAnswer = answer; },
    told,
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

test("the window is told once a signature exists, and never when nothing was signed", async () => {
  for (const kind of ["sign", "sign-typed", "transaction"] as const) {
    const run = fixture(kind);
    run.release();
    assert.equal(await run.run(), signature);
    assert.deepEqual(run.told, [signature], kind);
  }
  for (const kind of ["sign", "sign-typed", "transaction"] as const) {
    const run = fixture(kind);
    const pending = run.run();
    await run.waitForKey();
    run.lock();
    run.release();
    await assert.rejects(pending);
    assert.deepEqual(run.told, [], `${kind}: refused before signing`);
  }
  for (const kind of ["connect", "switch-network"] as const) {
    const run = fixture(kind);
    run.release();
    await run.run();
    assert.deepEqual(run.told, [], `${kind} signs nothing`);
  }
});

test("nothing is signed with less than the signing reserve left before the worker gives up", async () => {
  for (const kind of ["sign", "sign-typed", "transaction"] as const) {
    const late = fixture(kind);
    late.request.at -= 240_000 - 40_000;
    late.release();
    await assert.rejects(late.run(), /Review/);
    assert.equal(late.signatures(), 0, kind);
    assert.deepEqual(late.told, [], kind);
    const inTime = fixture(kind);
    inTime.request.at -= 240_000 - 40_000 - 5_000;
    inTime.release();
    assert.equal(await inTime.run(), signature, kind);
  }
});

test("approving a watch-asset adds the contract's metadata for the request's network and answers true", async () => {
  const run = fixture("watch-asset");
  run.release();
  assert.equal(await run.run(), "true");
  assert.deepEqual(run.tokenWrites, [{ address: `0x${"44".repeat(20)}`, networkId: "litvm", expected: run.shown }]);
  assert.equal(run.signatures(), 0);
  // Already listed (another site offered it meanwhile): true, nothing written.
  const again = fixture("watch-asset");
  again.tokenAlreadyAdded();
  assert.equal(await again.run(), "true");
  assert.deepEqual(again.tokenWrites, []);
  // Metadata that changed since the review is refused.
  const changed = fixture("watch-asset");
  changed.tokenChanged();
  await assert.rejects(changed.run(), /details changed/u);
  // The usual checks still hold: a revoked site adds nothing.
  const revoked = fixture("watch-asset");
  revoked.revoke();
  await assert.rejects(revoked.run(), /Review/u);
  assert.deepEqual(revoked.tokenWrites, []);
});

test("approving a network re-probes, refuses a changed answer before writing, and never selects it", async () => {
  const run = fixture("add-network");
  run.release();
  assert.equal(await run.run(), "added");
  assert.equal(run.networkWrites.length, 1);
  assert.equal(run.networkWrites[0]!.options.select, false);
  assert.equal(run.networkWrites[0]!.candidate.chainId, 8453);
  for (const answer of [1n, null]) {
    const moved = fixture("add-network");
    moved.probe(answer);
    await assert.rejects(moved.run(), /another chain/u);
    assert.deepEqual(moved.networkWrites, [], String(answer));
  }
  // Saved meanwhile (from Settings or another site): nothing replaced.
  const saved = fixture("add-network");
  saved.saveChain(8453);
  assert.equal(await saved.run(), "exists");
  const revoked = fixture("add-network");
  revoked.revoke();
  await assert.rejects(revoked.run(), /Review/u);
  assert.deepEqual(revoked.networkWrites, []);
});

test("an override that is not a lowered approve of the queued data is refused before signing", async () => {
  const spender = `0x${"55".repeat(20)}` as const;
  const asked = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 1000n] });
  for (const override of [
    encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 1001n] }),
    encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [other, 1n] }),
    encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [spender, 1n] }),
    `${encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 1n] })}00`,
  ]) {
    const run = fixture("transaction");
    run.request.tx = { to: other, value: "0x0", data: asked };
    run.release();
    await assert.rejects(run.runWith({ data: override }), /Review/);
    assert.equal(run.sent.length, 0);
    assert.equal(run.signatures(), 0);
  }
  // A transaction whose queued data is not an approve cannot be rewritten at all.
  const plain = fixture("transaction");
  plain.request.tx = { to: other, value: "0x0", data: "0xdeadbeef" };
  plain.release();
  await assert.rejects(plain.runWith({ data: asked }), /Review/);
  assert.equal(plain.sent.length, 0);
});

test("a lowered override is what sendRaw signs; to, value and gas come from the row", async () => {
  const spender = `0x${"55".repeat(20)}` as const;
  const asked = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 1000n * 10n ** 18n] });
  const lowered = approveAmount.rewriteApproveAmount(asked, 5n * 10n ** 18n)!;
  const run = fixture("transaction");
  run.request.tx = { to: other, value: "0x0", data: asked, gas: "0x186a0" };
  run.release();
  assert.equal(await run.runWith({ data: lowered }), signature);
  assert.deepEqual(run.sent, [{ to: other, value: 0n, data: lowered, gas: 100_000n }]);
  // The same bytes, or no override, sign the dapp's data untouched.
  const same = fixture("transaction");
  same.request.tx = { to: other, value: "0x0", data: asked };
  same.release();
  await same.runWith({ data: asked });
  assert.equal(same.sent[0]?.data, asked);
  const none = fixture("transaction");
  none.request.tx = { to: other, value: "0x0", data: asked };
  none.release();
  await none.runWith({});
  assert.equal(none.sent[0]?.data, asked);
});
