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
