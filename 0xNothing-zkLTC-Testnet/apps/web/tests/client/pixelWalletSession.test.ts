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
        "@/lib/contract": { publicClient: client, getMarketplaceTxUrl: () => "tx" }, "@/lib/pixelNftAbi": {},
        "@/lib/pixelPacking": { pixelDataToPackedBytes: () => "0x000007ffffff" },
        "@/lib/pixelCollections": { PIXEL_MINT_ADDRESS: collection, PIXEL_MINT_ENABLED: true, pixelUtf8Bytes: (value: string) => value.length },
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
