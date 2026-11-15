import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evaluateModule } from "../../../web/tests/helpers/evaluateModule.ts";
import { LITVM_RPC_URL } from "../../src/config/chain.ts";
import { withCreateClient } from "../helpers/viemClients.ts";
import {
  litvmRpcOverride,
  LITVM_NETWORK,
  networkIdentity,
  resolveNetwork,
  sanitizeCustomNetwork,
} from "../../src/config/networks.ts";

// O4: the user's own LiteForge RPC goes first, the public endpoint stays behind
// it for reads, and a signing operation pins exactly one endpoint.

test("1.0.9 settings resolve to exactly LITVM_NETWORK", () => {
  for (const stored of [undefined, "", null, 42, "not a url", { url: "https://x.example/" }]) {
    const network = resolveNetwork("litvm-4441", [], stored);
    assert.equal(network, LITVM_NETWORK);
    assert.equal(networkIdentity(network), networkIdentity(LITVM_NETWORK));
  }
  assert.equal(resolveNetwork("gone", []), LITVM_NETWORK);
});

test("the override accepts only https, never the default URL, credentials or a hash", () => {
  assert.equal(litvmRpcOverride(" https://my-node.example/rpc "), "https://my-node.example/rpc");
  for (const refused of [
    "http://my-node.example/",
    "http://127.0.0.1:8545/",
    "https://user:pw@my-node.example/",
    "https://my-node.example/#x",
    "javascript:alert(1)",
    "ftp://my-node.example/",
    LITVM_RPC_URL,
    ` ${LITVM_RPC_URL} `,
    "",
    7,
  ]) assert.equal(litvmRpcOverride(refused), null, String(refused));
});

test("the user RPC is first and the public endpoint the fallback", () => {
  const network = resolveNetwork("litvm-4441", [], "https://my-node.example/rpc");
  assert.equal(network.rpcUrl, "https://my-node.example/rpc");
  assert.deepEqual(network.fallbackRpcUrls, [LITVM_RPC_URL]);
  assert.equal(network.id, LITVM_NETWORK.id, "tokens and history stay keyed by the same profile and chain");
  assert.equal(network.chainId, 4441);
  assert.equal(network.builtin, true);
  assert.equal(resolveNetwork("litvm-4441", [], "https://my-node.example/rpc"), network, "the same object every read");
  assert.notEqual(networkIdentity(network), networkIdentity(LITVM_NETWORK));
  const custom = sanitizeCustomNetwork({
    name: "Base", chainId: 8453, rpcUrl: "https://base.example/", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  })!;
  assert.equal(resolveNetwork(custom.id, [custom], "https://my-node.example/rpc"), custom, "a custom network ignores it");
});

test("the worker and the UI compute the same network identity", () => {
  const read = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");
  const calls = (source: string) => [...source.matchAll(/resolveNetwork\(([^()]*)\)/gu)].map((match) => match[1]!);
  const expected: Array<[string, number]> = [
    ["core/rpc/client.ts", 1],
    ["core/services/dappExecution.ts", 1],
    ["ui/state/WalletContext.tsx", 2],
  ];
  for (const [path, count] of expected) {
    const found = calls(read(path));
    assert.equal(found.length, count, path);
    for (const args of found) assert.match(args, /\.litvmRpcUrl$/u, `${path}: ${args}`);
  }
  const worker = read("extension/background.ts");
  assert.match(worker, /resolveNetwork\(\s*saved\?\.networkId,\s*normalizeCustomNetworks\(saved\?\.customNetworks\),\s*saved\?\.litvmRpcUrl,\s*\)/u);
  assert.match(worker, /interface StoredNetworkSettings \{[^}]*litvmRpcUrl\?: unknown;/u);
  // The vault resolves ids only (unaffected by the override) and validates the field on read.
  assert.match(
    read("core/keyring/vault.ts"),
    /const litvmRpcUrl = litvmRpcOverride\(merged\.litvmRpcUrl\);\n\s+if \(litvmRpcUrl === null\) delete merged\.litvmRpcUrl;\n\s+else merged\.litvmRpcUrl = litvmRpcUrl;/u,
  );
});

const owner = `0x${"11".repeat(20)}`;

function signingFixture(network: Record<string, unknown>, answers: Record<string, bigint | null>) {
  const probed: string[] = [];
  const pinned: string[] = [];
  const rpc = evaluateModule<{
    walletClientFor(address: string, network?: unknown): Promise<{ transport: { url: string } }>;
    writeEndpoint(network: unknown, probe?: (url: string, timeoutMs?: number) => Promise<bigint | null>): Promise<string>;
  }>(new URL("../../src/core/rpc/client.ts", import.meta.url), {
    viem: withCreateClient({
      createPublicClient: (options: unknown) => options,
      createWalletClient: (options: unknown) => options,
      fallback: (transports: unknown[]) => ({ fallback: transports }),
      http: (url: string) => {
        pinned.push(url);
        return { url };
      },
      keccak256: () => "0x",
    }),
    "viem/actions": {},
    "viem/accounts": { toAccount: (source: unknown) => source },
    "../i18n": { t: (key: string) => key },
    "../../config/networks": {
      LITVM_NETWORK: network,
      networkIdentity: (entry: { rpcUrl: string }) => entry.rpcUrl,
      resolveNetwork: () => network,
      viemChainFor: () => ({ id: 4441 }),
    },
    "../keyring/vault": {
      signerFor: async () => ({ address: owner }),
      readAccounts: async () => ({ active: owner, accounts: [] }),
      readSettings: async () => ({ networkId: "litvm-4441", customNetworks: [] }),
      isUnlocked: async () => true,
    },
    "../services/rpcProbe": {
      probeChainId: async (url: string) => {
        probed.push(url);
        return answers[url] ?? null;
      },
    },
  });
  return { rpc, probed, pinned };
}

test("a write pins one endpoint: eth_sendRawTransaction reaches exactly one URL even when it times out", async () => {
  const network = { id: "litvm-4441", chainId: 4441, rpcUrl: "https://mine.example/", fallbackRpcUrls: [LITVM_RPC_URL], builtin: true };
  const { rpc, pinned } = signingFixture(network, { "https://mine.example/": 4441n, [LITVM_RPC_URL]: 4441n });
  pinned.length = 0;
  const client = await rpc.walletClientFor(owner, network);
  assert.deepEqual(client.transport, { url: "https://mine.example/" }, "a plain http transport, never the fallback");
  assert.deepEqual(pinned, ["https://mine.example/"]);
  // The source keeps the fallback for reads only.
  const source = readFileSync(new URL("../../src/core/rpc/client.ts", import.meta.url), "utf8");
  assert.match(source, /function transportFor\(rpcUrl: string\) \{\n  return http\(rpcUrl, \{/u);
  assert.match(source, /transport: transportFor\(rpcUrl\),/u);
});

test("writeEndpoint skips an endpoint answering another chain and throws before signing when none answers", async () => {
  const network = { id: "litvm-4441", chainId: 4441, rpcUrl: "https://mine.example/", fallbackRpcUrls: [LITVM_RPC_URL], builtin: true };
  const wrong = signingFixture(network, { "https://mine.example/": 1n, [LITVM_RPC_URL]: 4441n });
  assert.equal(await wrong.rpc.writeEndpoint(network), LITVM_RPC_URL);
  assert.deepEqual(wrong.probed, ["https://mine.example/", LITVM_RPC_URL]);
  const dead = signingFixture(network, {});
  await assert.rejects(dead.rpc.walletClientFor(owner, network), /err\.rpcUnavailable/u);
  dead.pinned.length = 0;
  await assert.rejects(dead.rpc.writeEndpoint(network), /err\.rpcUnavailable/u);
  assert.deepEqual(dead.pinned, [], "no signing transport is built");
});

test("without an override the write path is unchanged", async () => {
  const network = { id: "custom-8453-x", chainId: 8453, rpcUrl: "https://base.example/", builtin: false, fallbackRpcUrls: ["https://other.example/"] };
  const { rpc, probed } = signingFixture(network, {});
  const client = await rpc.walletClientFor(owner, network);
  assert.deepEqual(client.transport, { url: "https://base.example/" });
  assert.deepEqual(probed, [], "no probe call");
  const builtin = { ...LITVM_NETWORK };
  const plain = signingFixture(builtin, {});
  assert.equal(await plain.rpc.writeEndpoint(builtin), LITVM_RPC_URL);
  assert.deepEqual(plain.probed, []);
});
