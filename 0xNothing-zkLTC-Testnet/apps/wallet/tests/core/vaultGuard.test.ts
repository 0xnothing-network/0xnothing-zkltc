import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, type ViteDevServer } from "vite";

const PHRASE = "test test test test test test test test test test test junk";
const PASSWORD = "correct horse battery staple";
const WRONG = "wrong horse battery staple";
let server: ViteDevServer | null = null;

async function load() {
  server ??= await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  const [vault, storage, keys] = await Promise.all([
    server.ssrLoadModule("/src/core/keyring/vault.ts") as Promise<
      typeof import("../../src/core/keyring/vault.ts")
    >,
    server.ssrLoadModule("/src/core/platform/storage.ts") as Promise<
      typeof import("../../src/core/platform/storage.ts")
    >,
    server.ssrLoadModule("/src/core/platform/storageKeys.ts") as Promise<
      typeof import("../../src/core/platform/storageKeys.ts")
    >,
  ]);
  return { vault, ...storage, ...keys };
}

after(async () => {
  await server?.close();
});

async function derivations<T>(run: () => Promise<T>): Promise<{ result: T; count: number }> {
  const subtle = globalThis.crypto.subtle;
  const original = subtle.deriveKey;
  let count = 0;
  subtle.deriveKey = function (this: SubtleCrypto, ...args: Parameters<SubtleCrypto["deriveKey"]>) {
    count += 1;
    return original.apply(this, args);
  } as SubtleCrypto["deriveKey"];
  try {
    return { result: await run(), count };
  } finally {
    subtle.deriveKey = original;
  }
}

async function fresh() {
  const loaded = await load();
  await loaded.vault.wipeWallet();
  await loaded.vault.createVault(PASSWORD, PHRASE);
  await loaded.vault.lock();
  return loaded;
}

test("five wrong passwords are free; the sixth try, even the right one, waits without deriving", async () => {
  const { vault, persistentStore, STORAGE_KEYS } = await fresh();
  try {
    // Unlock and reveal share one counter.
    for (let i = 0; i < 3; i += 1) await assert.rejects(vault.unlock(WRONG), { name: "WrongPasswordError" });
    for (let i = 0; i < 2; i += 1) {
      await assert.rejects(vault.revealMnemonic(WRONG), { name: "WrongPasswordError" });
    }
    const before = Date.now();
    const at = await vault.unlockRetryAt();
    assert.ok(at >= before + 29_000 && at <= before + 31_000, String(at - before));

    const refused = await derivations(() => vault.unlock(PASSWORD).catch((error) => error));
    assert.equal((refused.result as Error).name, "UnlockThrottledError");
    assert.equal(refused.count, 0);
    assert.match((refused.result as Error).message, /Try again in \d+ s/u);
    await assert.rejects(vault.revealMnemonic(PASSWORD), { name: "UnlockThrottledError" });
    assert.equal(await vault.isUnlocked(), false);
    // A refused attempt is not itself counted.
    assert.equal((await persistentStore.get<{ failures: number }>(STORAGE_KEYS.unlockGuard))?.failures, 5);
  } finally {
    await vault.wipeWallet();
  }
});

test("the wait doubles after the free tries and is capped at 15 minutes", async () => {
  const { vault, persistentStore, STORAGE_KEYS } = await fresh();
  try {
    for (const [failures, expected] of [[5, 60_000], [7, 240_000], [12, 900_000], [999, 900_000]] as const) {
      await persistentStore.set(STORAGE_KEYS.unlockGuard, { failures, retryAt: 0 });
      const before = Date.now();
      await assert.rejects(vault.unlock(WRONG), { name: "WrongPasswordError" });
      const at = await vault.unlockRetryAt();
      assert.ok(Math.abs(at - before - expected) < 2_000, `${failures}: ${at - before}`);
    }
  } finally {
    await vault.wipeWallet();
  }
});

test("a wait written under a wrong clock is clamped to 15 minutes and stored so", async () => {
  const { vault, persistentStore, STORAGE_KEYS } = await fresh();
  try {
    await persistentStore.set(STORAGE_KEYS.unlockGuard, { failures: 9, retryAt: Date.now() + 365 * 86_400_000 });
    const limit = Date.now() + 15 * 60_000 + 1_000;
    assert.ok((await vault.unlockRetryAt()) <= limit);
    await assert.rejects(vault.unlock(PASSWORD), { name: "UnlockThrottledError" });
    const stored = await persistentStore.get<{ retryAt: number }>(STORAGE_KEYS.unlockGuard);
    assert.ok(stored!.retryAt <= limit, "the clamp is written back, so the wait ends");

    // Garbage in the record is no guard at all.
    for (const garbage of ["x", 7, [], { failures: "5", retryAt: "soon" }, { failures: -1, retryAt: Number.NaN }]) {
      await persistentStore.set(STORAGE_KEYS.unlockGuard, garbage);
      assert.equal(await vault.unlockRetryAt(), 0, JSON.stringify(garbage));
    }
  } finally {
    await vault.wipeWallet();
  }
});

test("the right password after the wait opens the wallet and resets the guard", async () => {
  const { vault, persistentStore, STORAGE_KEYS } = await fresh();
  try {
    for (let i = 0; i < 4; i += 1) await assert.rejects(vault.unlock(WRONG), { name: "WrongPasswordError" });
    assert.equal(await vault.unlockRetryAt(), 0);
    assert.equal((await vault.unlock(PASSWORD)).mnemonic, PHRASE);
    assert.equal(await persistentStore.get(STORAGE_KEYS.unlockGuard), null);

    await persistentStore.set(STORAGE_KEYS.unlockGuard, { failures: 8, retryAt: Date.now() - 1 });
    await vault.lock();
    assert.equal((await vault.unlock(PASSWORD)).mnemonic, PHRASE);
    assert.equal(await persistentStore.get(STORAGE_KEYS.unlockGuard), null);
  } finally {
    await vault.wipeWallet();
  }
});

test("erasing resets the settings but the language and theme, and removes the unlock guard and the staged-swap marker", async () => {
  const { vault, persistentStore, STORAGE_KEYS } = await fresh();
  const custom = {
    name: "Local node",
    chainId: 31337,
    rpcUrl: "https://rpc.example.test/key-in-path",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  };
  await vault.writeSettings({
    slippageBps: 300,
    autoLockMinutes: 60,
    theme: "light",
    locale: "vi",
    hideBalances: true,
    customNetworks: [custom] as never,
  });
  assert.equal((await vault.readSettings()).customNetworks.length, 1, "the fixture profile is valid");
  await persistentStore.set(STORAGE_KEYS.unlockGuard, { failures: 6, retryAt: Date.now() + 60_000 });
  await persistentStore.set(STORAGE_KEYS.pendingStagedSwap, { "0xabc:litvm-4441": { at: Date.now() } });
  await vault.wipeWallet();
  // The old locale stays, so the next boot does not flip from vi to English.
  assert.deepEqual(await vault.readSettings(), { ...vault.DEFAULT_SETTINGS, locale: "vi", theme: "light" });
  assert.deepEqual(await persistentStore.get(STORAGE_KEYS.settings), { locale: "vi", theme: "light" });
  assert.equal(await persistentStore.get(STORAGE_KEYS.unlockGuard), null);
  assert.equal(await persistentStore.get(STORAGE_KEYS.pendingStagedSwap), null);
  assert.equal(await vault.unlockRetryAt(), 0);
});
