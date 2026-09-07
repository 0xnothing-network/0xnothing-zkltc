import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, type ViteDevServer } from "vite";
import type { WalletNetwork } from "../../src/config/networks.ts";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const DAY = 24 * 60 * 60_000;
let server: ViteDevServer | null = null;
async function harness() {
  server ??= await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
  const portfolio = await server.ssrLoadModule("/src/core/services/portfolio.ts") as typeof import("../../src/core/services/portfolio.ts");
  const { persistentStore } = await server.ssrLoadModule("/src/core/platform/storage.ts");
  const { STORAGE_KEYS } = await server.ssrLoadModule("/src/core/platform/storageKeys.ts");
  const { LITVM_NETWORK } = await server.ssrLoadModule("/src/config/networks.ts");
  const first = LITVM_NETWORK as WalletNetwork;
  const second: WalletNetwork = { ...first, id: "custom-1", chainId: 1, rpcUrl: "https://rpc.example", builtin: false };
  await persistentStore.remove(STORAGE_KEYS.snapshots);
  return { portfolio, persistentStore, key: STORAGE_KEYS.snapshots, first, second };
}
after(async () => { await server?.close(); });

test("24h portfolio samples stay separate for the same wallet on different networks", async (context) => {
  const { portfolio, first, second } = await harness();
  context.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  await portfolio.recordSnapshot(ADDRESS, 100n, first);
  await portfolio.recordSnapshot(ADDRESS, 1_000n, second);
  context.mock.timers.tick(DAY);
  assert.equal(await portfolio.change24h(ADDRESS, 110n, first), 0.1);
  assert.equal(await portfolio.change24h(ADDRESS, 900n, second), -0.1);
});

test("unscoped legacy samples cannot be attributed to an arbitrary network", async (context) => {
  const { portfolio, persistentStore, key, first, second } = await harness();
  context.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  await persistentStore.set(key, { [ADDRESS]: [{ at: Date.now() - DAY, totalWad: "100" }] });
  assert.equal(await portfolio.change24h(ADDRESS, 110n, first), null);
  assert.equal(await portfolio.change24h(ADDRESS, 110n, second), null);
});

test("changing the RPC profile cannot reuse an earlier network's snapshot", async (context) => {
  const { portfolio, first } = await harness();
  context.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  await portfolio.recordSnapshot(ADDRESS, 100n, first);
  context.mock.timers.tick(DAY);
  const edited = { ...first, rpcUrl: "https://other.example" };
  assert.equal(await portfolio.change24h(ADDRESS, 110n, edited), null);
  assert.equal(await portfolio.change24h(ADDRESS, 110n, first), 0.1);
});
