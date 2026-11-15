import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress } from "viem";

// dapp.ts reads `chrome` when it loads, so the in-memory storage goes in first and
// the module is imported after it. Each test file runs in its own process.
const store: Record<string, unknown> = {};
const local = {
  async get(key: string | null) {
    return key === null ? structuredClone(store) : { [key]: structuredClone(store[key]) };
  },
  async set(bag: Record<string, unknown>) {
    for (const [key, value] of Object.entries(bag)) store[key] = structuredClone(value);
  },
  async remove(key: string) {
    delete store[key];
  },
};
(globalThis as { chrome?: unknown }).chrome = {
  storage: {
    local,
    session: local,
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
};

const dapp = await import("../../src/core/services/dapp.ts");
const { STORAGE_KEYS } = await import("../../src/core/platform/storageKeys.ts");

const accountA = `0x${"aa".repeat(20)}` as const;
const accountB = `0x${"bb".repeat(20)}` as const;
const defi = "https://defi.example";
const mint = "https://mint.example";

async function reset(): Promise<void> {
  await local.set({ [STORAGE_KEYS.connections]: {} });
}

test("a 1.0.9 book of one account per site reads as a one-element list", async () => {
  await local.set({
    [STORAGE_KEYS.connections]: { [defi]: { origin: defi, accounts: [accountA], at: 1_700_000_000_000 } },
  });
  assert.deepEqual(await dapp.listConnections(), [{ origin: defi, accounts: [accountA], at: 1_700_000_000_000 }]);
  assert.deepEqual(await dapp.connectedAccounts(defi, accountA), [accountA]);
  assert.deepEqual(await dapp.connectedAccounts(defi, getAddress(accountA)), [accountA]);
  assert.deepEqual(await dapp.connectedAccounts(defi, accountB), []);
});

test("switching account never shows a site an account it was not given", async () => {
  await reset();
  await dapp.grantConnection(defi, [accountA]);
  await dapp.grantConnection(mint, [accountB]);
  assert.deepEqual(await dapp.connectedAccounts(defi, accountA), [accountA]);
  assert.deepEqual(await dapp.connectedAccounts(defi, accountB), []);
  assert.deepEqual(await dapp.connectedAccounts(mint, accountA), []);
  assert.deepEqual(await dapp.connectedAccounts(mint, accountB), [accountB]);
  assert.deepEqual(await dapp.connectedAccounts(defi, null), []);
  // Connecting B to the first site adds it; A stays granted there.
  await dapp.grantConnection(defi, [accountB]);
  assert.deepEqual((await dapp.listConnections()).find((entry) => entry.origin === defi)?.accounts, [accountB, accountA]);
  assert.deepEqual(await dapp.connectedAccounts(defi, accountA), [accountA]);
  assert.deepEqual(await dapp.connectedAccounts(defi, accountB), [accountB]);
});

test("a site's list is newest first, holds each account once and stops at the cap", async () => {
  await reset();
  const accounts = Array.from({ length: 10 }, (_, index) => `0x${(index + 1).toString(16).padStart(2, "0").repeat(20)}` as `0x${string}`);
  for (const account of accounts) await dapp.grantConnection(defi, [account]);
  // The same account again, checksummed: moved to the front, not added twice.
  await dapp.grantConnection(defi, [getAddress(accounts[9]!)]);
  const stored = (await dapp.listConnections())[0]!.accounts;
  assert.equal(stored.length, dapp.MAX_ACCOUNTS_PER_ORIGIN);
  assert.equal(stored[0], getAddress(accounts[9]!));
  assert.deepEqual(stored.slice(1), accounts.slice(2, 9).reverse());
  assert.deepEqual(await dapp.connectedAccounts(defi, accounts[0]), []);
  // A hand-edited or future book with too many or repeated entries reads capped.
  await local.set({
    [STORAGE_KEYS.connections]: { [mint]: { origin: mint, accounts: [accountA, accountA, ...accounts], at: 1 } },
  });
  const read = (await dapp.listConnections())[0]!.accounts;
  assert.equal(read.length, dapp.MAX_ACCOUNTS_PER_ORIGIN);
  assert.deepEqual(read.slice(0, 2), [accountA, accounts[0]]);
});

test("revoking a site drops every account it was given", async () => {
  await reset();
  await dapp.grantConnection(defi, [accountA]);
  await dapp.grantConnection(defi, [accountB]);
  await dapp.revokeConnection(defi);
  assert.deepEqual(await dapp.connectedAccounts(defi, accountA), []);
  assert.deepEqual(await dapp.connectedAccounts(defi, accountB), []);
});

test("the worker resolves the active account as the approval window does", () => {
  assert.equal(dapp.resolveActiveAccount({ active: accountB, accounts: [{ address: accountA }] }), accountB);
  assert.equal(dapp.resolveActiveAccount({ active: null, accounts: [{ address: accountA }] }), accountA);
  assert.equal(dapp.resolveActiveAccount({ active: null, accounts: [] }), null);
  assert.equal(dapp.resolveActiveAccount(undefined), null);
  assert.deepEqual(dapp.visibleAccounts([accountA, accountB], accountB), [accountB]);
  assert.deepEqual(dapp.visibleAccounts([accountA], undefined), []);
});
