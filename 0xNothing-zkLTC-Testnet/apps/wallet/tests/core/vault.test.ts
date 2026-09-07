import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, type ViteDevServer } from "vite";

const PHRASE = "test test test test test test test test test test test junk";
let server: ViteDevServer | null = null;

async function loadVault() {
  server ??= await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  return server.ssrLoadModule("/src/core/keyring/vault.ts") as Promise<
    typeof import("../../src/core/keyring/vault.ts")
  >;
}

after(async () => {
  await server?.close();
});

test("a concurrent unlock cannot restore a session after the vault is wiped", async () => {
  const { createVault, hasVault, isUnlocked, lock, unlock, wipeWallet } = await loadVault();
  const password = "correct horse battery staple";
  await wipeWallet();
  try {
    await createVault(password, PHRASE);
    await lock();

    const unlocking = unlock(password);
    const wiping = wipeWallet();
    await Promise.allSettled([unlocking, wiping]);

    assert.equal(await hasVault(), false);
    assert.equal(await isUnlocked(), false);
  } finally {
    await wipeWallet();
  }
});

test("signing and key reveal reject public metadata that points at another HD key", async () => {
  const vault = await loadVault();
  const { persistentStore } = await server!.ssrLoadModule("/src/core/platform/storage.ts");
  const { STORAGE_KEYS } = await server!.ssrLoadModule("/src/core/platform/storageKeys.ts");
  const password = "correct horse battery staple";
  await vault.wipeWallet();
  try {
    const { accounts } = await vault.createVault(password, PHRASE);
    const first = accounts.accounts[0]!;
    assert.equal((await vault.signerFor(first.address)).address, first.address);
    const originalKey = await vault.revealPrivateKey(password, first.address);
    assert.match(originalKey, /^0x[0-9a-f]{64}$/iu);

    await persistentStore.set(STORAGE_KEYS.accounts, {
      accounts: [{ ...first, index: first.index + 1 }],
      active: first.address,
    });
    await assert.rejects(vault.signerFor(first.address));
    await assert.rejects(vault.revealPrivateKey(password, first.address));
  } finally {
    await vault.wipeWallet();
  }
});

test("imported-key metadata cannot authorize a signature for another address", async () => {
  const vault = await loadVault();
  const { persistentStore } = await server!.ssrLoadModule("/src/core/platform/storage.ts");
  const { STORAGE_KEYS } = await server!.ssrLoadModule("/src/core/platform/storageKeys.ts");
  const password = "correct horse battery staple";
  const importedKey = `0x${"1".padStart(64, "0")}` as const;
  await vault.wipeWallet();
  try {
    await vault.createVault(password, PHRASE);
    const state = await vault.importPrivateKey(password, importedKey);
    const imported = state.accounts.find((entry) => entry.source === "imported")!;
    const hd = state.accounts.find((entry) => entry.source === "hd")!;
    assert.equal((await vault.signerFor(imported.address)).address, imported.address);
    assert.equal(await vault.revealPrivateKey(password, imported.address), importedKey);
    await persistentStore.set(STORAGE_KEYS.accounts, {
      accounts: [{ ...imported, address: hd.address }],
      active: hd.address,
    });
    await assert.rejects(vault.signerFor(hd.address));
    await assert.rejects(vault.revealPrivateKey(password, hd.address));
  } finally {
    await vault.wipeWallet();
  }
});
