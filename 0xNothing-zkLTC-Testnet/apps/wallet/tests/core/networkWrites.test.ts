import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, type ViteDevServer } from "vite";
import { LITVM_RPC_URL } from "../../src/config/chain.ts";
import { chainScope } from "../../src/config/networks.ts";

// Two surfaces add networks now: the Settings form and a dapp's proposal in the
// approval window (F11). Both go through vault.addCustomNetwork, which re-reads
// the list under the settings lock and never replaces a saved chain.
let server: ViteDevServer | null = null;

async function load() {
  server ??= await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
  const [vault, release] = await Promise.all([
    server.ssrLoadModule("/src/core/keyring/vault.ts") as Promise<typeof import("../../src/core/keyring/vault.ts")>,
    server.ssrLoadModule("/src/ui/screens/settings/rpcRelease.ts") as Promise<
      typeof import("../../src/ui/screens/settings/rpcRelease.ts")
    >,
  ]);
  return { vault, ...release };
}

after(async () => {
  await server?.close();
});

const profile = (chainId: number, rpcUrl = `https://rpc-${chainId}.example/`, name = `Node ${chainId}`) => ({
  id: "", name, chainId, rpcUrl, explorerUrl: "", builtin: false,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
});

test("adding a saved chain writes nothing, never replaces it, and the built-in chain is never added", async () => {
  const { vault } = await load();
  await vault.wipeWallet();
  try {
    assert.equal(await vault.addCustomNetwork(profile(8453), { select: false }), "added");
    assert.equal(await vault.addCustomNetwork(profile(8453, "https://evil.example/", "Base"), { select: true }), "exists");
    assert.equal(await vault.addCustomNetwork(profile(4441), { select: true }), "exists");
    const settings = await vault.readSettings();
    assert.deepEqual(settings.customNetworks.map((entry) => [entry.chainId, entry.rpcUrl]), [[8453, "https://rpc-8453.example/"]]);
    assert.equal(settings.networkId, "litvm-4441", "select: false keeps the active network");
    await assert.rejects(vault.addCustomNetwork({ ...profile(7), rpcUrl: "http://evil.example/" }, { select: false }));
  } finally {
    await vault.wipeWallet();
  }
});

test("the 33rd network is refused, not dropped", async () => {
  const { vault } = await load();
  await vault.wipeWallet();
  try {
    for (let index = 0; index < 32; index += 1) {
      assert.equal(await vault.addCustomNetwork(profile(10_000 + index), { select: false }), "added");
    }
    await assert.rejects(vault.addCustomNetwork(profile(20_000), { select: false }));
    assert.equal((await vault.readSettings()).customNetworks.length, 32);
  } finally {
    await vault.wipeWallet();
  }
});

test("two writers never lose each other's network, and a removal keeps the rest", async () => {
  const { vault } = await load();
  await vault.wipeWallet();
  try {
    const results = await Promise.all([
      vault.addCustomNetwork(profile(100), { select: true }),
      vault.addCustomNetwork(profile(200), { select: false }),
      vault.addCustomNetwork(profile(300), { select: false }),
    ]);
    assert.deepEqual(results, ["added", "added", "added"]);
    const settings = await vault.readSettings();
    assert.deepEqual(settings.customNetworks.map((entry) => entry.chainId).sort(), [100, 200, 300]);
    const selected = settings.customNetworks.find((entry) => entry.chainId === 100)!;
    assert.equal(settings.networkId, selected.id);
    const after = await vault.removeCustomNetwork(selected.id);
    assert.deepEqual(after.customNetworks.map((entry) => entry.chainId).sort(), [200, 300]);
    assert.equal(after.networkId, "litvm-4441", "removing the active network falls back to the built-in one");
  } finally {
    await vault.wipeWallet();
  }
});

test("a host grant is released only when no saved network still uses that host", async () => {
  const { vault, releaseRpcPermissionUnlessUsed } = await load();
  await vault.wipeWallet();
  try {
    await vault.addCustomNetwork(profile(8453, "https://shared.example/a"), { select: false });
    const removed: string[][] = [];
    const api = { remove: async (request: { origins: string[] }) => { removed.push(request.origins); return true; } };
    await releaseRpcPermissionUnlessUsed("https://shared.example/b", api);
    assert.deepEqual(removed, [], "kept: a saved network uses the host");
    await releaseRpcPermissionUnlessUsed("https://unused.example/rpc", api);
    assert.deepEqual(removed, [["https://unused.example/*"]]);
    await releaseRpcPermissionUnlessUsed("https://x.example/", undefined);
    await releaseRpcPermissionUnlessUsed("https://x.example/", api, async () => { throw new Error("storage"); });
    assert.equal(removed.length, 1, "a failed read keeps the grant");
  } finally {
    await vault.wipeWallet();
  }
});

test("changing a custom network's RPC keeps its place, re-selects it and keeps its tokens and history", async () => {
  const { vault } = await load();
  await vault.wipeWallet();
  try {
    await vault.addCustomNetwork(profile(10), { select: false });
    await vault.addCustomNetwork(profile(8453), { select: true });
    await vault.addCustomNetwork(profile(42161), { select: false });
    const before = await vault.readSettings();
    const old = before.customNetworks[1]!;
    assert.equal(before.networkId, old.id);
    const next = await vault.replaceCustomNetworkRpc(old.id, { ...old, rpcUrl: "https://new-node.example/", name: "Renamed" });
    const after = await vault.readSettings();
    assert.deepEqual(after.customNetworks.map((entry) => entry.chainId), [10, 8453, 42161], "same place");
    const changed = after.customNetworks[1]!;
    assert.equal(changed.rpcUrl, "https://new-node.example/");
    assert.equal(changed.name, old.name, "only the RPC changes");
    assert.notEqual(changed.id, old.id);
    assert.equal(after.networkId, changed.id, "still selected");
    assert.equal(next.networkId, changed.id);
    // Tokens, history and recipients are keyed by chain, and the chain is the same.
    assert.equal(chainScope(changed.id), chainScope(old.id));
    // The same URL again changes nothing.
    assert.equal((await vault.replaceCustomNetworkRpc(changed.id, changed)).networkId, changed.id);
  } finally {
    await vault.wipeWallet();
  }
});

test("a changed chain id or a missing network is refused", async () => {
  const { vault } = await load();
  await vault.wipeWallet();
  try {
    await vault.addCustomNetwork(profile(8453), { select: false });
    const [saved] = (await vault.readSettings()).customNetworks;
    await assert.rejects(vault.replaceCustomNetworkRpc(saved!.id, { ...saved!, chainId: 10, rpcUrl: "https://x.example/" }));
    await assert.rejects(vault.replaceCustomNetworkRpc(saved!.id, { ...saved!, rpcUrl: "http://plain.example/" }));
    await assert.rejects(vault.replaceCustomNetworkRpc("custom-1-missing", { ...saved!, rpcUrl: "https://x.example/" }));
    assert.deepEqual((await vault.readSettings()).customNetworks, [saved]);
  } finally {
    await vault.wipeWallet();
  }
});

test("the override host is released before an erase and on reset unless a custom network uses it", async () => {
  const { vault, releaseRpcPermissionUnlessUsed, releaseCustomRpcPermissions } = await load();
  await vault.wipeWallet();
  try {
    const removed: string[][] = [];
    const api = { remove: async (request: { origins: string[] }) => { removed.push(request.origins); return true; } };
    await vault.writeSettings({ litvmRpcUrl: "https://my-node.example/rpc" });
    assert.equal((await vault.readSettings()).litvmRpcUrl, "https://my-node.example/rpc");
    await releaseRpcPermissionUnlessUsed("https://my-node.example/other", api);
    assert.deepEqual(removed, [], "kept while the override uses the host");
    await releaseCustomRpcPermissions(api);
    assert.deepEqual(removed, [["https://my-node.example/*"]], "an erase drops the override's host");
    removed.length = 0;
    await vault.writeSettings({ litvmRpcUrl: "" });
    assert.equal((await vault.readSettings()).litvmRpcUrl, undefined, "reset reads as unset");
    await releaseRpcPermissionUnlessUsed("https://my-node.example/rpc", api);
    assert.deepEqual(removed, [["https://my-node.example/*"]]);
    // The public LiteForge host is a manifest permission and is never dropped.
    removed.length = 0;
    await releaseRpcPermissionUnlessUsed(LITVM_RPC_URL, api);
    assert.deepEqual(removed, []);
    // A value no build would write reads as unset.
    await vault.writeSettings({ litvmRpcUrl: "http://plain.example/" });
    assert.equal((await vault.readSettings()).litvmRpcUrl, undefined);
  } finally {
    await vault.wipeWallet();
  }
});
