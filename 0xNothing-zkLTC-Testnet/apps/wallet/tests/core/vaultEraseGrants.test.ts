import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer | null = null;

async function load() {
  server ??= await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  const [vault, release] = await Promise.all([
    server.ssrLoadModule("/src/core/keyring/vault.ts") as Promise<
      typeof import("../../src/core/keyring/vault.ts")
    >,
    server.ssrLoadModule("/src/ui/screens/settings/rpcRelease.ts") as Promise<
      typeof import("../../src/ui/screens/settings/rpcRelease.ts")
    >,
  ]);
  return { vault, ...release };
}

after(async () => {
  await server?.close();
});

const remover = (refuse: string[] = []) => {
  const removed: string[][] = [];
  return {
    removed,
    async remove(request: { origins: string[] }): Promise<boolean> {
      removed.push(request.origins);
      if (request.origins.some((origin) => refuse.includes(origin))) {
        throw new Error("You cannot remove required permissions.");
      }
      return true;
    },
  };
};

const profile = (chainId: number, rpcUrl: string) => ({
  name: `Node ${chainId}`,
  chainId,
  rpcUrl,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
});

test("before an erase every custom RPC host grant is released, a refusal skipped", async () => {
  const { vault, releaseCustomRpcPermissions } = await load();
  await vault.wipeWallet();
  try {
    await vault.writeSettings({
      customNetworks: [
        profile(31337, "http://127.0.0.1:8545"),
        profile(7, "https://rpc.example.test/v1/key"),
      ] as never,
    });
    const api = remover(["http://127.0.0.1:8545/*"]);
    await releaseCustomRpcPermissions(api);
    assert.deepEqual(
      api.removed.map((origins) => origins.join()).sort(),
      ["http://127.0.0.1:8545/*", "https://rpc.example.test/*"],
    );
  } finally {
    await vault.wipeWallet();
  }
});

test("no permissions API or no custom profile releases nothing and never throws", async () => {
  const { vault, releaseCustomRpcPermissions } = await load();
  await vault.wipeWallet();
  await releaseCustomRpcPermissions(undefined);
  const api = remover();
  await releaseCustomRpcPermissions(api);
  assert.deepEqual(api.removed, [], "the built-in LitVM host is never released");
  // In node there is no extension, so the default resolves to no API at all.
  await releaseCustomRpcPermissions();
});

test("both erase paths release the grants before the wallet is wiped", () => {
  const read = (path: string): string => readFileSync(new URL(`../../src/ui/screens/${path}`, import.meta.url), "utf8");
  for (const path of ["Unlock.tsx", "settings/DangerZone.tsx"]) {
    assert.match(read(path), /await releaseCustomRpcPermissions\(\);\s*await wipeWallet\(\);/u, path);
  }
  assert.match(read("Settings.tsx"), /import \{ releaseRpcPermissionUnlessUsed \} from "\.\/settings\/rpcRelease";/u);
});

test("before an erase the shown notifications are cleared and the permission is given back", async () => {
  const { releaseNotificationsBeforeErase } = await load();
  const log: string[] = [];
  await releaseNotificationsBeforeErase({
    permissions: { remove: async (request) => { log.push(`remove:${request.permissions.join()}`); return true; } },
    notifications: {
      getAll: async () => ({ "tx:0xab": true, "req:1": true }),
      clear: async (id) => { log.push(`clear:${id}`); return true; },
    },
  });
  assert.deepEqual(log, ["clear:tx:0xab", "clear:req:1", "remove:notifications"]);
  // Permission not held (no notifications API) or a refusal: still no throw.
  const refused: string[] = [];
  await releaseNotificationsBeforeErase({
    permissions: { remove: async () => { refused.push("remove"); throw new Error("refused"); } },
  });
  assert.deepEqual(refused, ["remove"]);
  await releaseNotificationsBeforeErase({
    permissions: { remove: async () => true },
    notifications: { getAll: async () => { throw new Error("gone"); }, clear: async () => true },
  });
  await releaseNotificationsBeforeErase(undefined);
  await releaseNotificationsBeforeErase();
});

test("both erase paths give the notifications permission back before the wallet is wiped", () => {
  const read = (path: string): string => readFileSync(new URL(`../../src/ui/screens/${path}`, import.meta.url), "utf8");
  for (const path of ["Unlock.tsx", "settings/DangerZone.tsx"]) {
    assert.match(read(path), /await releaseNotificationsBeforeErase\(\);\s*await releaseCustomRpcPermissions\(\);\s*await wipeWallet\(\);/u, path);
  }
});
