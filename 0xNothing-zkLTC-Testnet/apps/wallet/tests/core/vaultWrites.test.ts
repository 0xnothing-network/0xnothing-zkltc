import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, type ViteDevServer } from "vite";

/**
 * The keyring writes that can lock a user out: password change, key import,
 * creation over an existing vault, erase, and the auto-lock deadline. Only the
 * public anvil phrase and keys appear here. Each PBKDF2 run costs ~0.3 s, so the
 * file keeps to about fifteen.
 */
const PHRASE = "test test test test test test test test test test test junk";
const PASSWORD = "correct horse battery staple";
const NEXT = "tulip harbor lantern 42";
let server: ViteDevServer | null = null;

/** The public anvil test key for an HD index of PHRASE, derived here rather than pasted. */
async function phraseKey(index: number): Promise<`0x${string}`> {
  const { mnemonicToAccount } = await import("viem/accounts");
  const { bytesToHex } = await import("viem");
  return bytesToHex(mnemonicToAccount(PHRASE, { addressIndex: index }).getHdKey().privateKey!);
}

async function load() {
  server ??= await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  const [vault, crypto, storage, keys] = await Promise.all([
    server.ssrLoadModule("/src/core/keyring/vault.ts") as Promise<
      typeof import("../../src/core/keyring/vault.ts")
    >,
    server.ssrLoadModule("/src/core/keyring/crypto.ts") as Promise<
      typeof import("../../src/core/keyring/crypto.ts")
    >,
    server.ssrLoadModule("/src/core/platform/storage.ts") as Promise<
      typeof import("../../src/core/platform/storage.ts")
    >,
    server.ssrLoadModule("/src/core/platform/storageKeys.ts") as Promise<
      typeof import("../../src/core/platform/storageKeys.ts")
    >,
  ]);
  return { vault, crypto, ...storage, ...keys };
}

after(async () => {
  await server?.close();
});

async function fresh() {
  const loaded = await load();
  await loaded.vault.wipeWallet();
  await loaded.vault.createVault(PASSWORD, PHRASE);
  return loaded;
}

test("a password change opens with the new password only and keeps the wallet unlocked", async () => {
  const { vault, persistentStore, STORAGE_KEYS } = await fresh();
  try {
    await vault.changePassword(PASSWORD, NEXT);
    assert.equal(await vault.isUnlocked(), true);
    assert.equal((await vault.getSecret()).mnemonic, PHRASE);

    // A wrong current password changes nothing.
    const sealed = await persistentStore.get(STORAGE_KEYS.vault);
    await assert.rejects(vault.changePassword(PASSWORD, "orchid canyon velvet 7"), {
      name: "WrongPasswordError",
    });
    assert.deepEqual(await persistentStore.get(STORAGE_KEYS.vault), sealed);

    await vault.lock();
    await assert.rejects(vault.unlock(PASSWORD), { name: "WrongPasswordError" });
    assert.equal((await vault.unlock(NEXT)).mnemonic, PHRASE);
  } finally {
    await vault.wipeWallet();
  }
});

test("importing a key keeps its label and index; the same key again only switches to it", async () => {
  const { vault } = await fresh();
  const key = await phraseKey(2);
  try {
    const first = await vault.importPrivateKey(PASSWORD, key, "Cold");
    const imported = first.accounts.find((meta) => meta.source === "imported")!;
    assert.deepEqual([imported.index, imported.label, first.active], [0, "Cold", imported.address]);
    assert.equal((await vault.signerFor(imported.address)).address, imported.address);

    const hd = first.accounts.find((meta) => meta.source === "hd")!;
    await vault.setActiveAccount(hd.address);
    const again = await vault.importPrivateKey(PASSWORD, key, "Renamed");
    assert.deepEqual(again.accounts, first.accounts, "no second row, the label stays");
    assert.equal(again.active, imported.address);
    assert.equal(await vault.revealPrivateKey(PASSWORD, imported.address), key);
    assert.equal((await vault.getSecret()).imported.length, 1, "no second copy of the key");
  } finally {
    await vault.wipeWallet();
  }
});

test("an imported key that is a later HD address is skipped by add account", async () => {
  const { vault } = await fresh();
  try {
    const state = await vault.importPrivateKey(PASSWORD, await phraseKey(1));
    const added = await vault.addHdAccount();
    const hd = added.accounts.filter((meta) => meta.source === "hd").map((meta) => meta.index);
    assert.deepEqual(hd, [0, 2]);
    assert.equal(new Set(added.accounts.map((meta) => meta.address.toLowerCase())).size, 3);
    assert.notEqual(added.active, state.active);
  } finally {
    await vault.wipeWallet();
  }
});

test("creating a wallet never overwrites a stored vault, readable or not", async () => {
  const { vault, persistentStore, STORAGE_KEYS } = await fresh();
  try {
    const sealed = await persistentStore.get(STORAGE_KEYS.vault);
    const accounts = await persistentStore.get(STORAGE_KEYS.accounts);
    await assert.rejects(vault.createVault(NEXT), /already/iu);
    assert.deepEqual(await persistentStore.get(STORAGE_KEYS.vault), sealed);
    assert.deepEqual(await persistentStore.get(STORAGE_KEYS.accounts), accounts);

    for (const unreadable of ["garbage", { v: 9 }, 0, []]) {
      await persistentStore.set(STORAGE_KEYS.vault, unreadable);
      await assert.rejects(vault.createVault(NEXT), /already/iu, JSON.stringify(unreadable));
      assert.deepEqual(await persistentStore.get(STORAGE_KEYS.vault), unreadable);
    }
  } finally {
    await vault.wipeWallet();
  }
});

test("erasing removes every persistent wallet record and the session", async () => {
  const { vault, persistentStore, sessionStore, STORAGE_KEYS } = await fresh();
  const sessionOnly = new Set<string>([STORAGE_KEYS.session, STORAGE_KEYS.sessionDeadline]);
  try {
    // Every key, so a record added later without an erase rule fails here.
    for (const key of Object.values(STORAGE_KEYS)) {
      if (!sessionOnly.has(key) && (await persistentStore.get(key)) === null) {
        await persistentStore.set(key, { written: key });
      }
    }
    assert.equal(await vault.isUnlocked(), true);
    await vault.wipeWallet();
    const left = (await persistentStore.keys()).filter((key) =>
      (Object.values(STORAGE_KEYS) as string[]).includes(key));
    // Settings alone come back, holding nothing but the language and the theme.
    assert.deepEqual(left, [STORAGE_KEYS.settings]);
    const kept = await persistentStore.get<Record<string, unknown>>(STORAGE_KEYS.settings);
    assert.deepEqual(Object.keys(kept ?? {}).sort(), ["locale", "theme"]);
    for (const key of sessionOnly) assert.equal(await sessionStore.get(key), null, key);
    assert.equal(await vault.hasVault(), false);
  } finally {
    await vault.wipeWallet();
  }
});

test("a deadline that passed while the app was away locks it, and the first tap cannot revive it", async () => {
  // A hidden Android WebView throttles the UI timer; the vault compares the wall clock.
  const { vault, sessionStore, STORAGE_KEYS } = await fresh();
  try {
    await sessionStore.set(STORAGE_KEYS.sessionDeadline, Date.now() - 1);
    await vault.touchSession();
    assert.equal(await vault.isUnlocked(), false);
    assert.equal(await sessionStore.get(STORAGE_KEYS.session), null);
    await assert.rejects(vault.getSecret(), { name: "WalletLockedError" });

    // Still inside the deadline, the same return keeps it open.
    assert.equal((await vault.unlock(PASSWORD)).mnemonic, PHRASE);
    await sessionStore.set(STORAGE_KEYS.sessionDeadline, Date.now() + 60_000);
    await vault.touchSession();
    assert.equal(await vault.isUnlocked(), true);
  } finally {
    await vault.wipeWallet();
  }
});

test("an unlock with no vault is not counted as a wrong password", async () => {
  const { vault, persistentStore, STORAGE_KEYS } = await load();
  await vault.wipeWallet();
  try {
    for (let i = 0; i < 7; i += 1) {
      await assert.rejects(vault.unlock(PASSWORD), { name: "WalletLockedError" });
    }
    assert.equal(await persistentStore.get(STORAGE_KEYS.unlockGuard), null);
    assert.equal(await vault.unlockRetryAt(), 0);
  } finally {
    await vault.wipeWallet();
  }
});

test("a wrong password on a 1.0.9 non-ASCII vault counts once, however many forms it tries", async () => {
  const { vault, crypto, persistentStore, STORAGE_KEYS } = await fresh();
  const legacy = "mật khẩu ví 2026".normalize("NFD");
  try {
    await vault.lock();
    // The blob exactly as 1.0.9 sealed it: the typed bytes, no `pw` tag.
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.deriveKey(legacy, salt);
    const plaintext = new TextEncoder().encode(JSON.stringify({ mnemonic: PHRASE, imported: [] }));
    const data = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
    await persistentStore.set(STORAGE_KEYS.vault, {
      v: 1,
      kdf: "PBKDF2-SHA256",
      iterations: crypto.PBKDF2_ITERATIONS,
      salt: crypto.bytesToBase64(salt),
      iv: crypto.bytesToBase64(iv),
      data: crypto.bytesToBase64(data),
    });
    await assert.rejects(vault.unlock("sai mật khẩu ví 2026".normalize("NFC")), { name: "WrongPasswordError" });
    assert.equal((await persistentStore.get<{ failures: number }>(STORAGE_KEYS.unlockGuard))?.failures, 1);
    assert.equal((await vault.unlock(legacy.normalize("NFC"))).mnemonic, PHRASE);
    assert.equal(await persistentStore.get(STORAGE_KEYS.unlockGuard), null);
  } finally {
    await vault.wipeWallet();
  }
});
