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

test("malformed persisted session deadlines fail closed and activity cannot extend them", async () => {
  const vault = await loadVault();
  const { sessionStore } = await server!.ssrLoadModule("/src/core/platform/storage.ts");
  const { STORAGE_KEYS } = await server!.ssrLoadModule("/src/core/platform/storageKeys.ts");
  const password = "correct horse battery staple";
  await vault.wipeWallet();
  try {
    await vault.createVault(password, PHRASE);
    const validSession = await sessionStore.get(STORAGE_KEYS.session);
    for (const invalidDeadline of ["never", Number.NaN, Number.POSITIVE_INFINITY, true, {}, []]) {
      await sessionStore.setMany([
        [STORAGE_KEYS.session, validSession],
        [STORAGE_KEYS.sessionDeadline, invalidDeadline],
      ]);
      await vault.touchSession();
      assert.equal(await vault.isUnlocked(), false, String(invalidDeadline));
      assert.equal(await sessionStore.get(STORAGE_KEYS.session), null);
    }
  } finally {
    await vault.wipeWallet();
  }
});

/** The public anvil test key for an HD index of PHRASE, derived here rather than pasted. */
async function phraseKey(index: number): Promise<`0x${string}`> {
  const { mnemonicToAccount } = await import("viem/accounts");
  const { bytesToHex } = await import("viem");
  return bytesToHex(mnemonicToAccount(PHRASE, { addressIndex: index }).getHdKey().privateKey!);
}

test("add account skips an HD address that is already there as an imported key", async () => {
  const vault = await loadVault();
  const password = "correct horse battery staple";
  await vault.wipeWallet();
  try {
    await vault.createVault(password, PHRASE);
    await vault.importPrivateKey(password, await phraseKey(1));
    const first = await vault.addHdAccount();
    const second = await vault.addHdAccount();
    const hd = second.accounts.filter((meta) => meta.source === "hd").map((meta) => meta.index);
    assert.deepEqual(hd, [0, 2, 3]);
    assert.equal(first.active, first.accounts.at(-1)!.address);
    assert.equal(second.active, second.accounts.at(-1)!.address);
    assert.equal((await vault.signerFor(second.active!)).address, second.active);
  } finally {
    await vault.wipeWallet();
  }
});

test("a malformed private key is refused before it can be sealed into the vault", async () => {
  const vault = await loadVault();
  const password = "correct horse battery staple";
  const hex = "1".padStart(64, "0");
  await vault.wipeWallet();
  try {
    await vault.createVault(password, PHRASE);
    for (const bad of [`0X${hex}`, `0x${hex.slice(1)}`, `0x${"g".repeat(64)}`, hex]) {
      await assert.rejects(vault.importPrivateKey(password, bad as `0x${string}`), /64 hex/u, bad);
    }
    await vault.lock();
    assert.deepEqual((await vault.unlock(password)).imported, []);
  } finally {
    await vault.wipeWallet();
  }
});

test("re-importing repairs an import that was cut between the vault and the account list", async () => {
  const vault = await loadVault();
  const { persistentStore } = await server!.ssrLoadModule("/src/core/platform/storage.ts");
  const { STORAGE_KEYS } = await server!.ssrLoadModule("/src/core/platform/storageKeys.ts");
  const password = "correct horse battery staple";
  const key = `0x${"1".padStart(64, "0")}` as const;
  await vault.wipeWallet();
  try {
    await vault.createVault(password, PHRASE);
    const vaultBefore = await persistentStore.get(STORAGE_KEYS.vault);
    const accountsBefore = await persistentStore.get(STORAGE_KEYS.accounts);

    // The account list was written, the vault was not.
    const state = await vault.importPrivateKey(password, key, "Cold");
    const address = state.active!;
    await persistentStore.set(STORAGE_KEYS.vault, vaultBefore);
    await vault.unlock(password);
    await assert.rejects(vault.signerFor(address));
    const repaired = await vault.importPrivateKey(password, key);
    assert.equal((await vault.signerFor(address)).address, address);
    assert.deepEqual(repaired.accounts.filter((meta) => meta.source === "imported").map((meta) => [meta.index, meta.label]), [[0, "Cold"]]);

    // The vault was written, the account list was not: no second copy of the key.
    await persistentStore.set(STORAGE_KEYS.accounts, accountsBefore);
    const relisted = await vault.importPrivateKey(password, key);
    assert.equal(relisted.accounts.length, 2);
    assert.equal((await vault.unlock(password)).imported.length, 1);
    assert.equal((await vault.signerFor(address)).address, address);
  } finally {
    await vault.wipeWallet();
  }
});

test("a session key read just before another surface's password change does not lock the wallet", async () => {
  const vault = await loadVault();
  const { sessionStore } = await server!.ssrLoadModule("/src/core/platform/storage.ts");
  const { STORAGE_KEYS } = await server!.ssrLoadModule("/src/core/platform/storageKeys.ts");
  const password = "correct horse battery staple";
  const original = sessionStore.get;
  await vault.wipeWallet();
  try {
    await vault.createVault(password, PHRASE);
    const oldRecord = await sessionStore.get(STORAGE_KEYS.session);
    await vault.changePassword(password, "tulip harbor lantern 42");
    const freshRecord = await sessionStore.get(STORAGE_KEYS.session);

    // This surface read the old key, then the new blob: the retry finds the new key.
    let stale = 1;
    sessionStore.get = async (key: string) =>
      key === STORAGE_KEYS.session && stale-- > 0 ? oldRecord : original.call(sessionStore, key);
    assert.equal((await vault.getSecret()).mnemonic, PHRASE);
    assert.deepEqual(await original.call(sessionStore, STORAGE_KEYS.session), freshRecord);

    // Both reads stale: refused as locked, yet the fresh session is not deleted.
    stale = 2;
    await assert.rejects(vault.getSecret(), { name: "WalletLockedError" });
    sessionStore.get = original;
    assert.equal(await vault.isUnlocked(), true);

    // A key that is stale in storage too is still dropped.
    await sessionStore.set(STORAGE_KEYS.session, oldRecord);
    await assert.rejects(vault.getSecret(), { name: "WalletLockedError" });
    assert.equal(await vault.isUnlocked(), false);
  } finally {
    sessionStore.get = original;
    await vault.wipeWallet();
  }
});
