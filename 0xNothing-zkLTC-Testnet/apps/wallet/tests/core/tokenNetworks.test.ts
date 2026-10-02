import assert from "node:assert/strict";
import test from "node:test";
import { isAddress } from "viem";
import { evaluateModule } from "../../../web/tests/helpers/evaluateModule.ts";

const address = `0x${"11".repeat(20)}`;
const customAddress = `0x${"22".repeat(20)}`;

function fixture() {
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
  const customClient = { readContract: read("CUSTOM") };
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
    "../../config/networks": { LITVM_NETWORK: builtin },
    "../i18n": { t: (key: string) => key },
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
