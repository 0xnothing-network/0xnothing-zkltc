import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { QueryClient, QueryObserver, type QueryObserverOptions } from "@tanstack/react-query";
import * as viem from "viem";
import { evaluateModule } from "../helpers/evaluateModule.ts";

const ACCOUNT = `0x${"1".repeat(40)}` as const;
const OTHER = `0x${"2".repeat(40)}` as const;
const TOKEN = `0x${"3".repeat(40)}` as const;
const FACTORY = `0x${"4".repeat(40)}` as const;
const NUSD = `0x${"5".repeat(40)}` as const;
const HASH = `0x${"a".repeat(64)}` as const;
const config = { PUMP_CHAIN_ID: 4441, PUMP_CONFIGURED: true, NUSD_CONFIGURED: true, PUMP_FACTORY_ADDRESS: FACTORY, PUMP_NUSD_ADDRESS: NUSD, PUMP_BPS_DENOMINATOR: 10_000n };
const market = { tokenAddress: TOKEN, creator: ACCOUNT, name: "Token", symbol: "TOKEN", status: "TRADING", priceNusd: "1" };

function portfolioHarness() {
  let address: string | undefined = ACCOUNT;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const observers: QueryObserver[] = [];
  const unsubscribe: Array<() => void> = [];
  const visibility: Array<{ key: string; enabled?: boolean }> = [];
  const publicClientOptions: unknown[] = [];
  const balanceReads: string[] = [];
  let slot = 0;
  let delayNextBalance = false;
  const hooks = evaluateModule<{ usePumpPortfolio: () => { held: unknown[]; balances: Map<string, bigint>; heldIsLoading: boolean } }>(
    new URL("../../features/pump/hooks/usePumpData.ts", import.meta.url),
    {
      react: { useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn, useDeferredValue: (value: unknown) => value },
      "@tanstack/react-query": {
        useQuery: (options: QueryObserverOptions) => {
          const index = slot++;
          const observerOptions = { ...options, gcTime: Infinity };
          if (!observers[index]) {
            observers[index] = new QueryObserver(client, observerOptions);
            unsubscribe[index] = observers[index].subscribe(() => {});
          } else observers[index].setOptions(observerOptions);
          return observers[index].getCurrentResult();
        },
      },
      wagmi: {
        useAccount: () => ({ address }),
        usePublicClient: (options: unknown) => {
          publicClientOptions.push(options);
          return { multicall: async ({ contracts }: { contracts: Array<{ args: [string] }> }) => {
            balanceReads.push(contracts[0].args[0]);
            if (delayNextBalance) return new Promise(() => {});
            return contracts.map(() => ({ status: "success", result: 7n }));
          } };
        },
      },
      viem,
      "@/features/pump/config": config,
      "@/features/pump/abis": { pumpTokenAbi: [] },
      "@/lib/http": { fetchJson: async () => ({ markets: [market], configured: true, source: "subgraph" }) },
      "@/lib/liveData": { STEADY_LIVE_MS: 10_000 },
      "@/features/pump/hooks/usePumpPolling": { pumpPollInterval: () => false, usePumpVisibilityRefresh: (options: { key: string; enabled?: boolean }) => visibility.push(options) },
      "@/features/pump/types": { DEFAULT_PUMP_CANDLE_PERIOD: 3600, PUMP_CANDLE_LIMITS: {} },
    },
    { URLSearchParams },
  );
  return {
    render: () => { slot = 0; return hooks.usePumpPortfolio(); },
    switchAccount: (next: string | undefined) => { address = next; delayNextBalance = true; },
    addMarket: () => {
      delayNextBalance = true;
      client.setQueryData(["pump-portfolio-markets"], { markets: [market, { ...market, tokenAddress: OTHER }], configured: true, source: "subgraph" });
    },
    visibility, publicClientOptions, balanceReads,
    close: () => { unsubscribe.forEach((fn) => fn()); client.clear(); },
  };
}

test("Pump portfolio clears the previous wallet's balances during account switch", async () => {
  const harness = portfolioHarness();
  try {
    harness.render();
    await setImmediate();
    harness.render();
    await setImmediate();
    assert.equal(harness.render().held.length, 1);
    harness.switchAccount(OTHER);
    const switched = harness.render();
    assert.equal(switched.balances.size, 0);
    assert.equal(switched.held.length, 0);
    assert.equal(switched.heldIsLoading, true);
  } finally { harness.close(); }
});

test("Pump portfolio pins balance reads to LitVM and stops visibility refresh after disconnect", async () => {
  const harness = portfolioHarness();
  try {
    harness.render();
    await setImmediate();
    harness.render();
    await setImmediate();
    assert.ok(harness.publicClientOptions.every((options) => (options as { chainId?: number })?.chainId === 4441));
    harness.switchAccount(undefined);
    assert.equal(harness.render().balances.size, 0);
    assert.equal(harness.visibility.filter(({ key }) => key.startsWith("pump-portfolio:balances:")).at(-1)?.enabled, false);
  } finally { harness.close(); }
});

test("Pump portfolio keeps known balances while refreshing the same wallet's expanded token list", async () => {
  const harness = portfolioHarness();
  try {
    harness.render();
    await setImmediate();
    harness.render();
    await setImmediate();
    assert.equal(harness.render().balances.get(TOKEN), 7n);
    harness.addMarket();
    const refreshed = harness.render();
    assert.equal(refreshed.balances.get(TOKEN), 7n);
    assert.equal(refreshed.held.length, 1);
  } finally { harness.close(); }
});

interface ElementNode { type: unknown; props: Record<string, unknown> & { children?: unknown; onClick?: () => void } }
function descendants(value: unknown): ElementNode[] {
  if (Array.isArray(value)) return value.flatMap(descendants);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const element = value as ElementNode;
  return [element, ...descendants(element.props.children)];
}

function tradeHarness(change?: "account" | "chain" | "connector" | "disconnect", mode = "buy") {
  const account = { address: ACCOUNT as string, isConnected: true, chainId: 4441, connector: { uid: "wallet-a" } };
  const writes: Array<{ functionName: string; account?: string; chainId?: number }> = [];
  const errors: Error[] = [];
  const readOptions: Array<{ chainId?: number }> = [];
  const publicClientOptions: Array<{ chainId?: number } | undefined> = [];
  let done = false;
  let stateIndex = 0;
  const states = [mode, "1", 100n, false];
  const guardModule = evaluateModule(new URL("../../features/pump/walletSession.ts", import.meta.url), {
    "wagmi/actions": { getAccount: () => account }, "@/features/pump/config": config,
  });
  const jsx = (type: unknown, props: ElementNode["props"]) => ({ type, props });
  const component = evaluateModule<{ TradePanel: (props: unknown) => ElementNode }>(
    new URL("../../features/pump/components/TradePanel.tsx", import.meta.url),
    {
      "react/jsx-runtime": { jsx, jsxs: jsx },
      react: {
        useMemo: (fn: () => unknown) => fn(), useRef: (current: unknown) => ({ current }),
        useState: () => { const index = stateIndex++; return [states[index], (value: unknown) => { states[index] = value as never; if (index === 3 && value === false) done = true; }]; },
      },
      "@tanstack/react-query": { useQueryClient: () => ({}) },
      viem,
      wagmi: {
        useConfig: () => ({}),
        useAccount: () => ({ ...account }),
        usePublicClient: (options: { chainId?: number } | undefined) => {
          publicClientOptions.push(options);
          return { waitForTransactionReceipt: async () => {
            if (change === "account") account.address = OTHER;
            if (change === "chain") account.chainId = 1;
            if (change === "connector") account.connector = { uid: "wallet-b" };
            if (change === "disconnect") account.isConnected = false;
            return { status: "success" };
          } };
        },
        useReadContract: (options: { functionName: string; chainId?: number }) => {
          readOptions.push(options);
          const data = options.functionName === "quoteBuy" ? [2n, 1n, 1n, 0n, false]
            : options.functionName === "quoteSell" ? [1n, 1n, 0n]
              : options.functionName === "balanceOf" ? 100n * 10n ** 18n : 0n;
          return { data, refetch: async () => ({}), isLoading: false };
        },
        useSwitchChain: () => ({}),
        useWriteContract: () => ({ writeContractAsync: async (request: typeof writes[number]) => { writes.push(request); return HASH; } }),
      },
      "@/features/pump/walletSession": guardModule,
      "@/features/pump/abis": { zeroXPumpAbi: [], pumpTokenAbi: [], nusdAbi: [] },
      "@/features/pump/config": config,
      "@/features/pump/format": { formatCompactNumber: String },
      "@/components/Toast": { useToast: () => ({ info() {}, success() {}, warning() {}, error() {}, handleError: (error: Error) => errors.push(error) }) },
      "@/lib/liveData": { invalidateAfterPumpTrade: async () => {} },
      "@/lib/actionLock": { tryAcquireAction: (ref: { current: boolean }) => ref.current ? false : (ref.current = true), releaseAction: (ref: { current: boolean }) => { ref.current = false; } },
      // A settled pass-through, which is what the real hook returns once the
      // field stops changing — the only state a trade is ever submitted from.
      // Loading it for real would also claim a fifth `useState` slot, and this
      // harness answers positionally from a four-entry list, so the hook would
      // read `undefined` and report itself forever pending, gating the quote
      // off and stalling the trade these tests exist to follow.
      "@/lib/useDebouncedValue": { useDebouncedValue: (value: unknown) => ({ value, pending: false }) },
    },
  );
  return {
    run: async () => {
      const tree = component.TradePanel({ market });
      descendants(tree).find((node) => node.type === "button" && String(node.props.className).includes("pump-button-large"))?.props.onClick?.();
      for (let index = 0; index < 30 && !done; index += 1) await setImmediate();
      assert.equal(done, true, "trade handler completed");
    },
    writes, errors, readOptions, publicClientOptions,
  };
}

for (const change of ["account", "chain", "connector", "disconnect"] as const) {
  test(`Pump stops approval-to-trade continuation after wallet ${change} changes`, async () => {
    const harness = tradeHarness(change);
    await harness.run();
    assert.deepEqual(harness.writes.map(({ functionName }) => functionName), ["approve"]);
    assert.equal(harness.errors.length, 1);
  });
}

test("Pump keeps the original approval/trade flow on the intended account and chain", async () => {
  const harness = tradeHarness();
  await harness.run();
  assert.deepEqual(harness.writes.map(({ functionName }) => functionName), ["approve", "buy"]);
  assert.equal(harness.errors.length, 0);
  assert.ok(harness.readOptions.every(({ chainId }) => chainId === 4441));
  assert.ok(harness.publicClientOptions.every((options) => options?.chainId === 4441));
  assert.ok(harness.writes.every(({ account, chainId }) => account === ACCOUNT && chainId === 4441));
});

test("Pump keeps the sell approval and trade bound to the original wallet", async () => {
  const harness = tradeHarness(undefined, "sell");
  await harness.run();
  assert.deepEqual(harness.writes.map(({ functionName }) => functionName), ["approve", "sell"]);
  assert.equal(harness.errors.length, 0);
  assert.ok(harness.writes.every(({ account, chainId }) => account === ACCOUNT && chainId === 4441));
});

type PumpComponent = "CreateTokenForm" | "NusdOraclePanel" | "TokenDetail" | "PumpStatsDashboard";
function componentHarness(name: PumpComponent, changeAt?: "simulation" | "upload" | "creationSimulation", metadataValue?: unknown, oracleMode = "mint") {
  const account = { address: ACCOUNT as string, isConnected: true, chainId: 4441, connector: { uid: "wallet-a" } };
  const controller = OTHER;
  const router = `0x${"6".repeat(40)}`;
  const adapter = `0x${"7".repeat(40)}`;
  const zero = `0x${"0".repeat(40)}`;
  const writes: Array<{ functionName: string; account?: string; chainId?: number }> = [];
  const errors: Error[] = [];
  let done = false;
  let stateIndex = 0;
  const file = new File([new Uint8Array([137, 80, 78, 71])], "logo.png", { type: "image/png" });
  const states: unknown[] = name === "CreateTokenForm" ? ["idle", "Token", "TOKEN", "Description", "", "", file, ""]
    : name === "NusdOraclePanel" ? [oracleMode, "1", "1", false] : [false];
  const pumpConfig = { ...config, ZERO_ADDRESS: zero, PUMP_CREATE_FEE: 1n, PUMP_GRADUATION_CONTROLLER_ADDRESS: controller,
    PUMP_GRADUATION_ROUTER_ADDRESS: router, PUMP_GRADUATION_ADAPTER_ADDRESS: adapter,
    isValidPumpExternalUrl: () => true, normalizePumpIpfsPath: () => "", ipfsToGatewayUrl: () => "https://metadata.test", normalizePumpExternalUrl: (value: string) => value.trim() };
  const guardModule = evaluateModule(new URL("../../features/pump/walletSession.ts", import.meta.url), {
    "wagmi/actions": { getAccount: () => account }, "@/features/pump/config": pumpConfig,
  });
  const jsx = (type: unknown, props: ElementNode["props"]) => ({ type, props });
  const toast = { info() {}, success() {}, warning() {}, error() {}, show() {}, handleError: (error: Error) => errors.push(error) };
  const read = async ({ functionName }: { functionName: string }) => functionName === "createdTokenByContentHash" ? zero
    : functionName === "creationReservations" ? changeAt === "upload"
      : functionName === "allowance" ? viem.maxUint256 : 100n * 10n ** 18n;
  const publicClient = {
    readContract: read,
    simulateContract: async ({ functionName }: { functionName: string }) => {
      if (changeAt === "simulation" || (changeAt === "creationSimulation" && functionName === "createMarket")) account.address = OTHER;
      return {};
    },
    waitForTransactionReceipt: async () => ({ status: "success", logs: [] }),
  };
  let metadataQuery: { queryFn: (options: { signal: AbortSignal }) => Promise<unknown> } | undefined;
  let metadataData: unknown;
  const component = evaluateModule<Record<PumpComponent, (props?: unknown) => ElementNode>>(
    new URL(`../../features/pump/components/${name}.tsx`, import.meta.url),
    {
      "react/jsx-runtime": { jsx, jsxs: jsx },
      react: {
        useMemo: (fn: () => unknown) => fn(), useRef: (current: unknown) => ({ current }), useEffect() {},
        useState: () => { const index = stateIndex++; return [states[index], (value: unknown) => { states[index] = value; if (value === false || value === "idle") done = true; }]; },
      },
      "next/navigation": { useRouter: () => ({ push() {} }) },
      "next/link": { default: "a" },
      "@tanstack/react-query": { useQuery: (options: typeof metadataQuery) => { metadataQuery = options; return { data: metadataData }; } },
      viem,
      wagmi: {
        useConfig: () => ({}), useAccount: () => ({ ...account }), usePublicClient: () => publicClient,
        useBalance: () => ({ data: { value: 100n * 10n ** 18n }, isPending: false, refetch: async () => ({}) }),
        useReadContract: ({ functionName, address }: { functionName: string; address?: string }) => {
          const data = functionName === "admin" ? name === "PumpStatsDashboard" ? ACCOUNT : controller
            : functionName === "graduationRouter" || functionName === "router" ? router
              : functionName === "pump" ? FACTORY : functionName === "adapter" ? adapter
                : functionName === "oracle" ? adapter
                  : functionName === "readPriceWad" ? [100n, 1n, 1n]
                    : ["graduationsPaused", "mintPaused", "redeemPaused"].includes(functionName) ? false
                      : ["enabled", "isAdapterAllowed", "isFresh"].includes(functionName) ? true
                        : functionName === "governance" ? ACCOUNT : 10n * 10n ** 18n;
          void address;
          return { data, isPending: false, isLoading: false, refetch: async () => ({}) };
        },
        useSwitchChain: () => ({ switchChainAsync: async () => {} }),
        useWriteContract: () => ({ writeContractAsync: async (request: typeof writes[number]) => { writes.push(request); return HASH; } }),
      },
      "@/features/pump/walletSession": guardModule,
      "@/features/pump/config": pumpConfig,
      "@/features/pump/abis": { zeroXPumpAbi: [], nusdAbi: [], diaOracleAdapterAbi: [], pumpGraduationControllerAbi: [], pumpGraduationRouterAbi: [] },
      "@/features/pump/hooks/useIpfsUpload": { useIpfsUpload: () => ({ upload: async () => {
        if (changeAt === "upload") account.address = OTHER;
        return { metadataURI: "ipfs://metadata", imageURI: "ipfs://image" };
      } }) },
      "@/features/pump/contentHash": { computePumpContentHash: async () => HASH },
      "@/features/pump/imageValidation": { PUMP_MAX_IMAGE_BYTES: 2_000_000, validatePumpImage: async () => null },
      "@/features/pump/format": { formatCompactNumber: String, formatRelativeTime: String, formatWad: String, shortAddress: String, formatDecimal: String },
      "@/features/pump/hooks/usePumpData": { usePumpMarket: () => ({ data: { market: { ...market, status: "READY", metadataURI: "ipfs://metadata" } }, refetch: async () => ({}) }),
        usePumpStats: () => ({ refetch: async () => ({}) }), usePumpMarkets: () => ({ markets: [] }) },
      "@/features/pump/components/PumpStates": {},
      "@/features/pump/components/LazyPumpChart": {}, "@/features/pump/components/PumpTokenLogo": {},
      "@/features/pump/components/TradePanel": {}, "@/features/pump/components/TradeHistory": {}, "@/features/pump/components/TokenHolders": {},
      "@/lib/explorer": { getAddressExplorerUrl: String },
      "@/lib/contract": { publicClient, getTransactionExplorerUrl: String },
      "@/components/Toast": { useToast: () => toast },
      "@/lib/actionLock": { tryAcquireAction: (ref: { current: boolean }) => ref.current ? false : (ref.current = true), releaseAction: (ref: { current: boolean }) => { ref.current = false; } },
    },
    { TextEncoder, fetch: async () => ({ ok: true, headers: { get: () => null }, json: async () => metadataValue ?? { configured: true } }) },
  );
  const render = () => { stateIndex = 0; return component[name]({ token: TOKEN }); };
  return {
    run: async () => {
      let tree = render();
      if (name === "TokenDetail" || name === "PumpStatsDashboard") {
        const nested = descendants(tree).find((node) => typeof node.type === "function" && node.type.name === (name === "TokenDetail" ? "GraduationAction" : "DeveloperFeePanel"));
        assert.ok(nested);
        tree = (nested.type as (props: unknown) => ElementNode)(nested.props);
      }
      const button = descendants(tree).find((node) => node.type === "button" && String(node.props.className).includes("pump-button-primary"));
      assert.ok(button?.props.onClick);
      button.props.onClick();
      for (let index = 0; index < 30 && !done; index += 1) await setImmediate();
      assert.equal(done, true, "transaction handler completed");
    },
    readMetadata: async () => {
      render();
      assert.ok(metadataQuery);
      metadataData = await metadataQuery.queryFn({ signal: new AbortController().signal });
      assert.doesNotThrow(render);
      return metadataData as { description?: unknown; external_url?: unknown; properties?: { website?: unknown; twitter?: unknown } };
    },
    writes, errors,
  };
}

for (const name of ["CreateTokenForm", "NusdOraclePanel", "TokenDetail", "PumpStatsDashboard"] as const) {
  test(`${name} stops a write when the wallet changes during simulation`, async () => {
    const harness = componentHarness(name, "simulation");
    await harness.run();
    assert.equal(harness.writes.length, 0);
    assert.equal(harness.errors.length, 1);
  });
  test(`${name} preserves successful writes on the original wallet`, async () => {
    const harness = componentHarness(name);
    await harness.run();
    assert.ok(harness.writes.length > 0);
    assert.equal(harness.errors.length, 0);
    assert.ok(harness.writes.every(({ account, chainId }) => account === ACCOUNT && chainId === 4441));
  });
}

test("CreateTokenForm stops after an upload if the wallet changed", async () => {
  const harness = componentHarness("CreateTokenForm", "upload");
  await harness.run();
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.errors.length, 1);
});

test("TokenDetail treats external metadata as untrusted JSON before rendering", async () => {
  const harness = componentHarness("TokenDetail", undefined, { description: { unsafe: true }, external_url: 7, properties: { website: ["https://example.test"], twitter: { url: "https://example.test" } } });
  const metadata = await harness.readMetadata();
  assert.equal(typeof metadata.description === "object", false);
  assert.equal(typeof metadata.external_url === "number", false);
  assert.equal(typeof metadata.properties?.twitter === "object", false);
});

test("CreateTokenForm checks the wallet again after the final creation simulation", async () => {
  const harness = componentHarness("CreateTokenForm", "creationSimulation");
  await harness.run();
  assert.deepEqual(harness.writes.map(({ functionName }) => functionName), ["reserveMarket"]);
  assert.equal(harness.errors.length, 1);
});

test("NUSD redemption preserves the recipient and stops on a wallet change", async () => {
  const changed = componentHarness("NusdOraclePanel", "simulation", undefined, "redeem");
  await changed.run();
  assert.equal(changed.writes.length, 0);
  assert.equal(changed.errors.length, 1);
  const unchanged = componentHarness("NusdOraclePanel", undefined, undefined, "redeem");
  await unchanged.run();
  assert.deepEqual(unchanged.writes.map(({ functionName }) => functionName), ["redeemAtOracle"]);
  assert.ok(unchanged.writes.every(({ account, chainId }) => account === ACCOUNT && chainId === 4441));
  assert.equal(unchanged.errors.length, 0);
});

test("TokenDetail keeps valid metadata text and links", async () => {
  const source = { description: "Token description", external_url: "https://example.test", properties: { website: "https://example.test", twitter: "https://social.test" } };
  const metadata = await componentHarness("TokenDetail", undefined, source).readMetadata();
  assert.equal(metadata.description, source.description);
  assert.equal(metadata.external_url, source.external_url);
  assert.equal(metadata.properties?.website, source.properties.website);
  assert.equal(metadata.properties?.twitter, source.properties.twitter);
});
