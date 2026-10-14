import assert from "node:assert/strict";
import test from "node:test";
import { pixelDataToPackedBytes, pixelCellSize, pixelHistoryLimit } from "../../lib/pixelPacking.ts";
import { getPixelImageUrl } from "../../lib/pixelImage.ts";
import { evaluateModule } from "../helpers/evaluateModule.ts";

const classic = `0x${"1".repeat(40)}` as const;
const current = `0x${"2".repeat(40)}` as const;
function grid(size: number, color: string) { return Array.from({ length: size }, () => Array<string>(size).fill(color)); }

test("packing encodes a 256-pixel row in one canonical six-byte run", () => {
  const pixels = grid(256, "transparent");
  pixels[255].fill("#1234Ab");
  assert.equal(pixelDataToPackedBytes(pixels, 256), "0x00ffff1234ab");
  const full = pixelDataToPackedBytes(grid(256, "#ffffff"), 256);
  assert.equal((full.length - 2) / 12, 256);
});

test("packing merges equivalent RGB casing and keeps transparent gaps", () => {
  const pixels = grid(8, "transparent");
  pixels[0] = ["#FF0000", "#ff0000", "transparent", "#ff0000", "transparent", "transparent", "transparent", "transparent"];
  assert.equal(pixelDataToPackedBytes(pixels, 8), "0x000001ff0000030000ff0000");
});

test("packing admits exactly 4096 runs and rejects denser artwork before a wallet request", () => {
  const checker = (size: number) => grid(size, "transparent").map((row, y) => row.map((_, x) => (x + y) % 2 ? "#000000" : "#ffffff"));
  assert.equal((pixelDataToPackedBytes(checker(64), 64).length - 2) / 12, 4096);
  assert.throws(() => pixelDataToPackedBytes(checker(128), 128), /4,096 color runs/);
  assert.throws(() => pixelDataToPackedBytes(grid(8, "red"), 8), /Invalid pixel color/);
  assert.throws(() => pixelDataToPackedBytes(grid(8, "#ffffff"), 128), /Invalid pixel grid/);
});

test("large grids retain fractional hit geometry and a bounded undo budget", () => {
  assert.equal(pixelCellSize(180, 256), 180 / 256);
  assert.equal(pixelCellSize(640, 64), 10);
  assert.ok(pixelCellSize(0, 256) > 0);
  assert.equal(pixelHistoryLimit(16), 50);
  assert.equal(pixelHistoryLimit(128), 16);
  assert.equal(pixelHistoryLimit(256), 4);
});

test("Classic image URLs stay stable while explicit collection URLs cannot collide", () => {
  assert.equal(getPixelImageUrl(1), "/api/pixel-image?tokenId=1");
  assert.notEqual(getPixelImageUrl(1, classic), getPixelImageUrl(1, current));
  assert.equal(getPixelImageUrl(1, current.toUpperCase()), getPixelImageUrl(1, current));
});

test("registry defaults to Classic URLs and validates collections and UTF-8 byte limits", () => {
  const registry = evaluateModule<{
    resolvePixelCollection: (value?: string | null) => string | null;
    pixelUtf8Bytes: (value: string) => number;
    pixelTokenKey: (collection: string, tokenId: number) => string;
  }>(new URL("../../lib/pixelCollections.ts", import.meta.url), {
    "./publicConfig": { PIXEL_CLASSIC_ADDRESS: classic, PIXEL_CLASSIC_START_BLOCK: 1n, PIXEL_NFT_ADDRESS: current, PIXEL_START_BLOCK: 2n },
  }, { TextEncoder });
  assert.equal(registry.resolvePixelCollection(), classic);
  assert.equal(registry.resolvePixelCollection(current.toUpperCase()), current);
  assert.equal(registry.resolvePixelCollection(`0x${"3".repeat(40)}`), null);
  assert.equal(registry.pixelUtf8Bytes("é".repeat(32)), 64);
  assert.equal(registry.pixelUtf8Bytes("🖼".repeat(256)), 1024);
  assert.notEqual(registry.pixelTokenKey(classic, 1), registry.pixelTokenKey(current, 1));
});

test("mint preflight passes immutable description and packed bytes to the estimate and wallet calldata", async () => {
  type Element = { type: unknown; props: Record<string, unknown> };
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const find = (root: unknown): Element | undefined => {
    if (Array.isArray(root)) return root.map(find).find(Boolean);
    if (!root || typeof root !== "object" || !("props" in root)) return undefined;
    const element = root as Element;
    return element.type === "mint-button" ? element : find(element.props.children);
  };
  const pixels = grid(256, "#ffffff");
  const packed = pixelDataToPackedBytes(pixels, 256);
  const description = "Art 🖼";
  let stateIndex = 0;
  const effects: (() => unknown)[] = [];
  const encoded: Array<{ functionName: string; args: unknown[] }> = [];
  const estimated: Array<{ functionName: string; args: unknown[]; address: string }> = [];
  const sends: Array<{ to: string; value: bigint }> = [];
  const client = {
    estimateContractGas: async (call: typeof estimated[number]) => { estimated.push(call); return 50_000n; },
    getBlock: async () => ({ gasLimit: 1_000_000n }),
  };
  const { MintPanel } = evaluateModule<{ MintPanel: (props: Record<string, unknown>) => Element }>(new URL("../../features/pixel/components/MintPanel.tsx", import.meta.url), {
    react: {
      memo: (value: unknown) => value, useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn,
      useState: (initial: unknown) => [["Art", description, false, null, true, "png", packed, ""][stateIndex++] ?? initial, () => {}],
      useRef: (current: unknown) => ({ current }), useEffect: (fn: () => unknown) => effects.push(fn),
    },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    wagmi: {
      useConfig: () => ({}),
      useAccount: () => ({ address: classic, isConnected: true, chainId: 4441 }), useSwitchChain: () => ({}),
      usePublicClient: () => client, useReadContract: () => ({ data: true }), useWaitForTransactionReceipt: () => ({}),
      useSendTransaction: () => ({ sendTransactionAsync: async (call: typeof sends[number]) => { sends.push(call); return "0xtx"; } }),
    },
    "@/lib/useProtocolReceipt": { useProtocolReceipt: () => ({}) },
    viem: { encodeFunctionData: (call: typeof encoded[number]) => { encoded.push(call); return "0xcalldata"; } },
    "@/lib/contract": { publicClient: client, getMarketplaceTxUrl: () => "tx" }, "@/lib/pixelNftAbi": { PixelNFTABI: [] },
    "@/lib/pixelPacking": { pixelDataToPackedBytes },
    "@/lib/pixelCollections": { PIXEL_MINT_ADDRESS: current, PIXEL_MINT_ENABLED: true, pixelUtf8Bytes: (value: string) => new TextEncoder().encode(value).length },
    "@/lib/gridParser": { pixelDataToPNG: () => "png" }, "@/features/pixel/components/PixelButton": { PixelButton: "mint-button" },
    "@/components/Toast": { useToast: () => ({ show: () => "toast" }) }, "@/lib/errors": { normalizeError: String },
    "@/lib/chainSwitch": { LITVM_CHAIN_ID: 4441 }, "@/components/PageLoader": {},
    "@/lib/actionLock": { tryAcquireAction: () => true, releaseAction() {} },
    "@/lib/walletSession": { createWalletSessionGuard: () => () => {} },
  }, { setTimeout: (callback: () => void) => { callback(); return 1; }, clearTimeout() {} });
  const tree = MintPanel({ pixelData: pixels, gridSize: 256, onMintSuccess() {} });
  effects[2]();
  const button = find(tree)!;
  assert.equal(button.props.disabled, false);
  await (button.props.onClick as () => Promise<void>)();
  assert.equal(encoded[0].functionName, "mintPacked");
  assert.deepEqual(Array.from(encoded[0].args), ["Art", description, 256n, packed]);
  assert.deepEqual(Array.from(estimated[0].args), ["Art", description, 256n, packed]);
  assert.equal(estimated[0].address, current);
  assert.equal(sends[0].to, current);
  assert.equal(sends[0].value, 0n);
  assert.equal((sends[0] as typeof sends[number] & { account: string; chainId: number }).account, classic);
  assert.equal((sends[0] as typeof sends[number] & { account: string; chainId: number }).chainId, 4441);
});
