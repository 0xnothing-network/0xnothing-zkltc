import assert from "node:assert/strict";
import test from "node:test";
import { evaluateModule } from "../helpers/evaluateModule.ts";

type Element = { type: unknown; props: Record<string, unknown> };
const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
function find(root: unknown, predicate: (value: Element) => boolean): Element | undefined {
  if (Array.isArray(root)) return root.map((item) => find(item, predicate)).find(Boolean);
  if (!root || typeof root !== "object" || !("props" in root)) return;
  const element = root as Element;
  return predicate(element) ? element : find(element.props.children, predicate);
}
const owner = "0x1111111111111111111111111111111111111111";
const collection = "0x2222222222222222222222222222222222222222";
const marketplace = "0x3333333333333333333333333333333333333333";

function sessionHarness() {
  const account = { address: owner, chainId: 4441, isConnected: true, connector: { uid: "wallet-a" } };
  const session = evaluateModule(new URL("../../lib/walletSession.ts", import.meta.url), {
    "wagmi/actions": { getAccount: () => account },
  });
  return { account, imports: { "@/lib/walletSession": session } };
}

test("Pixel mint stays on LitVM and aborts when wallet changes during gas estimation", async () => {
  for (const changed of ["address", "chainId", "connector"] as const) {
    const { account, imports } = sessionHarness();
    const pixels = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => "#ffffff"));
    let stateIndex = 0;
    const effects: (() => unknown)[] = [];
    const reads: Record<string, unknown>[] = [];
    const receipts: Record<string, unknown>[] = [];
    const clientOptions: unknown[] = [];
    const sends: unknown[] = [];
    const client = {
      estimateContractGas: async () => {
        if (changed === "address") account.address = collection;
        if (changed === "chainId") account.chainId = 1;
        if (changed === "connector") account.connector.uid = "wallet-b";
        return 50_000n;
      }, getBlock: async () => ({ gasLimit: 1_000_000n }),
    };
    const { MintPanel } = evaluateModule<{ MintPanel: (props: Record<string, unknown>) => Element }>(
      new URL("../../features/pixel/components/MintPanel.tsx", import.meta.url), {
        ...imports,
        react: {
          memo: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn,
          useState: (initial: unknown) => [["Artwork", "", false, null, true, "png", "0x000007ffffff", ""][stateIndex++] ?? initial, () => {}],
          useRef: (current: unknown) => ({ current }), useEffect: (fn: () => unknown) => effects.push(fn),
        }, "react/jsx-runtime": { jsx, jsxs: jsx },
        wagmi: {
          useConfig: () => ({}), useAccount: () => ({ ...account }), useSwitchChain: () => ({}),
          usePublicClient: (options: unknown) => { clientOptions.push(options); return client; },
          useReadContract: (options: Record<string, unknown>) => { reads.push(options); return { data: true }; },
          useWaitForTransactionReceipt: (options: Record<string, unknown>) => { receipts.push(options); return {}; },
          useSendTransaction: () => ({ sendTransactionAsync: async (options: unknown) => { sends.push(options); return "0xtx"; } }),
        }, "@/lib/useProtocolReceipt": { useProtocolReceipt: (options: Record<string, unknown>) => { receipts.push(options); return {}; } },
        viem: { encodeFunctionData: () => "0xcalldata" },
        "@/lib/contract": { publicClient: client, getMarketplaceTxUrl: () => "tx" }, "@/lib/pixelV2Abi": {},
        "@/lib/pixelV2": { pixelDataToV2PackedBytes: () => "0x000007ffffff" },
        "@/lib/pixelCollections": { PIXEL_MINT_ADDRESS: collection, PIXEL_V2_ENABLED: true, pixelUtf8Bytes: (value: string) => value.length },
        "@/lib/gridParser": { pixelDataToPNG: () => "png" }, "@/features/pixel/components/PixelButton": { PixelButton: "mint-button" },
        "@/components/Toast": { useToast: () => ({ show() {} }) }, "@/lib/errors": { normalizeError: () => ({ title: "Failed" }) },
        "@/lib/chainSwitch": { LITVM_CHAIN_ID: 4441 }, "@/components/PageLoader": {},
        "@/lib/actionLock": { tryAcquireAction: () => true, releaseAction() {} },
      }, { setTimeout: (fn: () => void) => { fn(); return 1; }, clearTimeout() {}, console: { error() {} } });
    const tree = MintPanel({ pixelData: pixels, gridSize: 8, onMintSuccess() {} });
    effects[2]();
    await (find(tree, (value) => value.type === "mint-button")!.props.onClick as () => Promise<void>)();
    assert.equal(sends.length, 0, `a changed ${changed} must not receive a mint request`);
    assert.equal((clientOptions[0] as { chainId: number }).chainId, 4441);
    assert.equal(reads[0].chainId, 4441);
    assert.equal(receipts[0].chainId, 4441);
  }
});

function listingHarness() {
  const session = sessionHarness();
  let stateIndex = 0, refIndex = 0, writeIndex = 0;
  const states: unknown[] = [], refs: { current: unknown }[] = [];
  let effects: (() => unknown)[] = [];
  let approvalHash: string | undefined;
  let approved = false;
  const writes: Record<string, unknown>[] = [], receipts: Record<string, unknown>[] = [];
  const { OwnedNftCard } = evaluateModule<{ OwnedNftCard: (props: Record<string, unknown>) => Element }>(
    new URL("../../features/pixel/components/OwnedNftCard.tsx", import.meta.url), {
      ...session.imports,
      react: {
        memo: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn,
        useState: (initial: unknown) => { const index = stateIndex++; if (!(index in states)) states[index] = initial; return [states[index], (next: unknown) => { states[index] = next; }]; },
        useRef: (current: unknown) => refs[refIndex++] ?? (refs[refIndex - 1] = { current }),
        useEffect: (fn: () => unknown) => effects.push(fn),
      }, "react/jsx-runtime": { jsx, jsxs: jsx }, "next/link": {},
      wagmi: {
        useAccount: () => ({ ...session.account }), useConfig: () => ({}),
        useWriteContract: () => writeIndex++ === 0
          ? { data: approvalHash, writeContractAsync: async (call: Record<string, unknown>) => { writes.push(call); approvalHash = "0xapproval"; return approvalHash; } }
          : { writeContractAsync: async (call: Record<string, unknown>) => { writes.push(call); return "0xlisting"; } },
        useWaitForTransactionReceipt: (options: Record<string, unknown>) => { receipts.push(options); return { data: options.hash && approved ? { status: "success" } : undefined }; },
      }, "@/lib/useProtocolReceipt": { useProtocolReceipt: (options: Record<string, unknown>) => { receipts.push(options); return { data: options.hash && approved ? { status: "success" } : undefined }; } },
      viem: { parseEther: (value: string) => BigInt(value), formatEther: String },
      "@/lib/contract": { PIXEL_MARKETPLACE_ADDRESS: marketplace, getTokenExplorerUrl: () => "", getMarketplaceTxUrl: () => "" },
      "@/lib/abi": {}, "@/lib/marketplaceAbi": {}, "@/lib/chainSwitch": { LITVM_CHAIN_ID: 4441 },
      "@/lib/actionLock": { tryAcquireAction: (ref: { current: boolean }) => { if (ref.current) return false; ref.current = true; return true; }, releaseAction: (ref: { current: boolean }) => { ref.current = false; } },
    });
  states[0] = "list";
  const tree = OwnedNftCard({ nft: { collection, tokenId: 1n, name: "Art", imageUrl: "", listing: null }, isPaused: false, onChanged() {} });
  const control = find(tree, (value) => typeof value.type === "function" && "onPriceChange" in value.props)!;
  states.length = 0; refs.length = 0;
  function render(price: string) {
    stateIndex = 0; refIndex = 0; writeIndex = 0; effects = [];
    const element = (control.type as (props: Record<string, unknown>) => Element)({ ...control.props, price });
    return { element, effects: [...effects] };
  }
  return { ...session, writes, receipts, render, confirm: () => { approved = true; } };
}

test("Pixel approval cannot automatically list from a replacement wallet", async () => {
  const harness = listingHarness();
  const first = harness.render("1");
  await (find(first.element, (value) => value.type === "button" && typeof value.props.onClick === "function" && value.props.children !== "CANCEL")!.props.onClick as () => Promise<void>)();
  harness.account.address = collection;
  harness.confirm();
  for (const effect of harness.render("1").effects) effect();
  await Promise.resolve();
  assert.equal(harness.writes.length, 1, "the old account's approval must not trigger a new account's listing");
  assert.equal(harness.writes[0].account, owner);
  assert.equal(harness.writes[0].chainId, 4441);
  assert.ok(harness.receipts.every((options) => options.chainId === 4441));
});

test("Pixel listing uses the price reviewed before approval, even if props change", async () => {
  const harness = listingHarness();
  const first = harness.render("1");
  await (find(first.element, (value) => value.type === "button" && typeof value.props.onClick === "function" && value.props.children !== "CANCEL")!.props.onClick as () => Promise<void>)();
  harness.confirm();
  for (const effect of harness.render("9").effects) effect();
  await Promise.resolve();
  assert.equal(harness.writes.length, 2);
  assert.equal((harness.writes[1].args as unknown[])[2], 1n);
  assert.equal(harness.writes[1].account, owner);
  assert.equal(harness.writes[1].chainId, 4441);
});

test("Pixel purchase rechecks the wallet after simulation and cancellation rejects a wrong network", async () => {
  for (const action of ["buy", "cancel"] as const) {
    const session = sessionHarness();
    let stage = "body", stateIndex = 0;
    const calls: Record<string, unknown>[] = [];
    const options: Record<string, unknown>[] = [];
    let switched = 0;
    const client = { readContract: async () => [collection, 1n, 7n, collection, true],
      simulateContract: async () => { session.account.connector.uid = "wallet-b"; } };
    const page = evaluateModule<{ default: () => Element }>(new URL("../../app/0xpixel/marketplace/page.tsx", import.meta.url), {
      ...session.imports,
      react: {
        useState: (initial: unknown) => {
          const index = stateIndex++;
          const data = { listings: [{ listingId: "1", collection, tokenId: "1", price: "7", seller: collection, active: true }], tokens: {} };
          return [stage === "body" && index === 3 ? data : initial, () => {}];
        }, useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn,
        useEffect() {}, useRef: (current: unknown) => ({ current }),
      }, "react/jsx-runtime": { jsx, jsxs: jsx },
      wagmi: {
        useAccount: () => ({ ...session.account }), useConfig: () => ({}),
        usePublicClient: (value: Record<string, unknown>) => { options.push(value); return client; },
        useSwitchChain: () => ({ switchChain: () => { switched++; } }),
        useWaitForTransactionReceipt: (value: Record<string, unknown>) => { options.push(value); return {}; },
        useWriteContract: () => ({ writeContractAsync: async (call: Record<string, unknown>) => { calls.push(call); return "0xtx"; } }),
      }, "@/lib/useProtocolReceipt": { useProtocolReceipt: (value: Record<string, unknown>) => { options.push(value); return {}; } },
      viem: { formatEther: String },
      "@/lib/contract": { PIXEL_MARKETPLACE_ADDRESS: marketplace, shortenAddress: String, getTokenExplorerUrl: () => "", getMarketplaceTxUrl: () => "" },
      "@/lib/marketplaceAbi": { marketplaceNftKey: (address: string, id: bigint) => `${address}:${id}` },
      "@/features/pixel/components/Skeleton": {}, "@/lib/chainSwitch": { LITVM_CHAIN_ID: 4441 }, "@/lib/http": {},
      "@/components/Toast": { useToast: () => ({ warning() {}, info() {}, error() {}, handleError() {} }) },
      "@/lib/actionLock": { tryAcquireAction: () => true, releaseAction() {} },
    });
    const body = find(page.default(), (value) => "userAddress" in value.props)!;
    const listing = find((body.type as (props: Record<string, unknown>) => Element)(body.props), (value) => "listing" in value.props)!;
    stage = "card"; stateIndex = 0;
    if (action === "cancel") session.account.chainId = 1;
    const card = (listing.type as (props: Record<string, unknown>) => Element)({ ...listing.props, userAddress: action === "cancel" ? collection : owner });
    const button = find(card, (value) => value.type === "button")!;
    await (button.props.onClick as () => Promise<void>)();
    assert.equal(calls.length, 0, action === "buy" ? "a replaced connector must not receive the purchase request" : "a wrong-network cancellation must not be signed");
    assert.ok(options.every((value) => value.chainId === 4441));
    if (action === "cancel") assert.equal(switched, 1);
  }
});
