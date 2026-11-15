import assert from "node:assert/strict";
import test from "node:test";
import { isAddress } from "viem";
import { evaluateModule } from "../../../web/tests/helpers/evaluateModule.ts";
import { chainScope } from "../../src/config/networks.ts";
import { IGNORABLE_LETTERS } from "../../src/core/lib/confusables.ts";

/** The real chain scoping, anchored to this fixture's stand-in LitVM id. */
function chainScoping(litvmId: string) {
  return {
    chainScope,
    onNetworkChain: (stored: string | undefined, id: string) => chainScope(stored ?? litvmId) === chainScope(id),
  };
}

const address = `0x${"11".repeat(20)}`;
const customAddress = `0x${"22".repeat(20)}`;

function fixture(customSymbol = "CUSTOM") {
  const builtin = { id: "litvm", rpcUrl: "https://builtin.example", builtin: true };
  const custom = { id: "custom", rpcUrl: "https://custom.example", builtin: false };
  let stored: unknown[] = [];
  const calls: string[] = [];
  const read = (symbol: string) => async ({ functionName }: { functionName: string }) => {
    calls.push(`${symbol}:${functionName}`);
    return functionName === "symbol" ? symbol
      : functionName === "name" ? `${symbol} token`
        : functionName === "decimals" ? (symbol === "CUSTOM" ? 6 : 18)
          : "";
  };
  const builtinClient = { readContract: read("LITVM") };
  const customClient = { readContract: read(customSymbol) };
  const native = { id: "native", symbol: "GAS", name: "Gas", decimals: 18, builtin: true };
  const canonical = { id: address, address, symbol: "NUSD", name: "NUSD", decimals: 18, builtin: true };
  const module = evaluateModule<{
    lookupToken(address: string, profile: typeof custom): Promise<{ symbol: string; decimals: number }>;
    addCustomToken(address: string, profile: typeof custom): Promise<Array<{ id: string; symbol: string; decimals: number }>>;
    listTokens(profile: typeof custom): Promise<Array<{ id: string; symbol: string }>>;
  }>(new URL("../../src/core/services/tokens.ts", import.meta.url), {
    viem: { isAddress },
    "../../abis": { erc20Abi: [], tokenImageAbi: [] },
    "../../config/assets": {
      BUILTIN_TOKENS: [native, canonical],
      customToken: (input: { address: string }) => ({ ...input, id: input.address.toLowerCase(), builtin: false }),
      nativeTokenFor: () => native,
    },
    "../../config/networks": { LITVM_NETWORK: builtin, ...chainScoping(builtin.id) },
    "../i18n": { t: (key: string) => key },
    "../lib/confusables": { IGNORABLE_LETTERS },
    "../platform/storage": { persistentStore: { get: async () => stored, set: async (_key: string, value: unknown[]) => { stored = value; } } },
    "../platform/storageKeys": { STORAGE_KEYS: { tokens: "tokens" } },
    "../platform/locks": { withNamedLock: (_key: string, action: () => unknown) => action() },
    "../rpc/client": {
      activeNetwork: builtin,
      publicClient: builtinClient,
      publicClientFor: (profile: typeof builtin) => profile.id === builtin.id ? builtinClient : customClient,
    },
  });
  return { ...module, custom, builtin, calls, seed: (rows: unknown[]) => { stored = rows; } };
}

test("an explicit token lookup uses that profile's RPC without changing the selected network", async () => {
  const run = fixture();
  const result = await run.lookupToken(customAddress, run.custom);
  assert.equal(result.symbol, "CUSTOM");
  assert.equal(result.decimals, 6);
  assert.ok(run.calls.every((call) => call.startsWith("CUSTOM:")));
});

test("a contract symbol with a zero-width space or word joiner is unreadable, while a saved one still loads", async () => {
  for (const hidden of [0x200b, 0x2060]) {
    const symbol = `NU${String.fromCodePoint(hidden)}SD`;
    const run = fixture(symbol);
    await assert.rejects(run.lookupToken(customAddress, run.custom), /err.tokenUnreadable/u, symbol);
    // A row an earlier version saved is not dropped by the new read rule.
    run.seed([{ address: customAddress, symbol, name: "Old", decimals: 6, networkId: run.custom.id }]);
    assert.deepEqual([...(await run.listTokens(run.custom)).map((token) => token.symbol)], ["GAS", symbol]);
  }
});

test("a contract symbol with a Hangul filler is unreadable, while a saved one still loads", async () => {
  // A letter Chrome draws as a blank gap: "NU<filler>SD" displays as "NU SD".
  for (const filler of [0x115f, 0x1160, 0x3164, 0xffa0]) {
    const symbol = `NU${String.fromCodePoint(filler)}SD`;
    const run = fixture(symbol);
    await assert.rejects(run.lookupToken(customAddress, run.custom), /err.tokenUnreadable/u, filler.toString(16));
    run.seed([{ address: customAddress, symbol, name: "Old", decimals: 6, networkId: run.custom.id }]);
    assert.deepEqual([...(await run.listTokens(run.custom)).map((token) => token.symbol)], ["GAS", symbol]);
  }
});

test("an address reserved as a LitVM builtin is importable on another chain", async () => {
  const run = fixture();
  const rows = await run.addCustomToken(address, run.custom);
  assert.equal(rows.find((row) => row.id === address)?.symbol, "CUSTOM");
  assert.equal(rows.find((row) => row.id === address)?.decimals, 6);
});

test("persisted cross-chain tokens sharing a canonical address remain visible only on their own profile", async () => {
  const run = fixture();
  run.seed([{ address, symbol: "OTHER", name: "Other chain", decimals: 6, networkId: run.custom.id }]);
  assert.equal((await run.listTokens(run.custom)).find((row) => row.id === address)?.symbol, "OTHER");
  assert.equal((await run.listTokens(run.builtin)).find((row) => row.id === address)?.symbol, "NUSD");
  await assert.rejects(run.addCustomToken(address, run.builtin), /tokenBuiltin/);
});

test("a custom chain's imports survive its profile being re-added with a new RPC", async () => {
  const run = fixture();
  const old = { ...run.custom, id: "custom-10-aaaa" };
  const readded = { ...run.custom, id: "custom-10-bbbb", rpcUrl: "https://new.example" };
  // Exactly what 1.0.9 stored: the old profile id, and a LitVM row with no id at all.
  run.seed([
    { address: customAddress, symbol: "OLD", name: "Old import", decimals: 6, networkId: old.id },
    { address: `0x${"33".repeat(20)}`, symbol: "LEGACY", name: "Legacy", decimals: 18 },
  ]);
  assert.ok((await run.listTokens(readded)).some((row) => row.symbol === "OLD"));
  assert.ok(!(await run.listTokens(readded)).some((row) => row.symbol === "LEGACY"));
  assert.ok((await run.listTokens(run.builtin)).some((row) => row.symbol === "LEGACY"));
  assert.ok(!(await run.listTokens({ ...run.custom, id: "custom-11-aaaa" })).some((row) => row.symbol === "OLD"));
  // Still the same import on the re-added profile: no second copy.
  await assert.rejects(run.addCustomToken(customAddress, readded), /tokenAdded/);
});

test("the 257th import is refused, and no earlier import is dropped to make room", async () => {
  const run = fixture();
  const full = Array.from({ length: 256 }, (_, index) => ({
    address: `0x${(index + 1).toString(16).padStart(40, "0")}`,
    symbol: `T${index}`,
    name: `Token ${index}`,
    decimals: 18,
    networkId: index === 0 ? undefined : run.custom.id,
  }));
  run.seed(full);
  await assert.rejects(run.addCustomToken(customAddress, run.custom), /tok\.full/);
  // The oldest one, on another network, is still there.
  assert.ok((await run.listTokens(run.builtin)).some((row) => row.symbol === "T0"));
  assert.equal((await run.listTokens(run.custom)).filter((row) => row.symbol.startsWith("T")).length, 255);
});
