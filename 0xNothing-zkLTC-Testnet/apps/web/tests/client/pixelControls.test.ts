import assert from "node:assert/strict";
import test from "node:test";
import { evaluateModule } from "../helpers/evaluateModule.ts";

type Element = { type: string | ((props: Record<string, unknown>) => Element); props: Record<string, unknown> };
function find(root: unknown, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(root)) return root.map((item) => find(item, predicate)).find(Boolean);
  if (!root || typeof root !== "object" || !("props" in root)) return undefined;
  const element = root as Element;
  return predicate(element) ? element : find(element.props.children, predicate);
}
const jsx = (type: Element["type"], props: Element["props"]) => ({ type, props });

function content(root: unknown): string {
  if (Array.isArray(root)) return root.map(content).join(" ");
  if (root && typeof root === "object" && "props" in root) return content((root as Element).props.children);
  return typeof root === "string" ? root : "";
}

test("originality is only advertised after a successful check and failures offer a retry", () => {
  let stateIndex = 0;
  let check: { data?: boolean; isError: boolean } = { isError: false };
  let retries = 0;
  const { MintPanel } = evaluateModule<{ MintPanel: (props: Record<string, unknown>) => Element }>(
    new URL("../../features/pixel/components/MintPanel.tsx", import.meta.url),
    {
      react: {
        memo: (fn: unknown) => fn,
        useState: (initial: unknown) => {
          const index = stateIndex++;
          return [index === 0 ? "Test" : index === 4 ? true : index === 6 ? "0xff" : initial, () => {}];
        },
        useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn,
        useRef: (current: unknown) => ({ current }), useEffect: () => {},
      },
      "react/jsx-runtime": { jsx, jsxs: jsx },
      wagmi: {
        useAccount: () => ({ address: "0xtest", isConnected: true, chainId: 4441 }),
        useSendTransaction: () => ({}), useWaitForTransactionReceipt: () => ({}),
        useReadContract: () => ({ ...check, refetch: () => { retries++; } }),
        usePublicClient: () => ({}), useSwitchChain: () => ({}),
      },
      viem: {}, "@/lib/contract": {}, "@/lib/abi": {},
      "@/features/pixel/components/PixelButton": { PixelButton: "pixel-button" },
      "@/lib/gridParser": {}, "@/components/Toast": { useToast: () => ({}) },
      "@/lib/errors": {}, "@/lib/chainSwitch": { LITVM_CHAIN_ID: 4441 },
      "@/components/PageLoader": {}, "@/lib/actionLock": {},
    },
  );
  const render = () => { stateIndex = 0; return MintPanel({ pixelData: [["#ffffff"]], gridSize: 1, onMintSuccess() {} }); };
  assert.doesNotMatch(content(render()), /ORIGINAL/);
  check = { isError: true };
  const failed = render();
  assert.match(content(failed), /CHECK FAILED/);
  assert.doesNotMatch(content(failed), /ORIGINAL/);
  const retry = find(failed, (element) => element.type === "pixel-button")!;
  assert.equal(retry.props.disabled, false);
  (retry.props.onClick as () => void)();
  assert.equal(retries, 1);
  check = { data: true, isError: false };
  assert.match(content(render()), /ORIGINAL/);
  check = { data: false, isError: false };
  assert.match(content(render()), /TAKEN/);
});

test("rejecting a listing after approval never opens another wallet request automatically", async () => {
  let firstRender = true;
  let writeIndex = 0;
  let refIndex = 0;
  let attempts = 0;
  const refs: { current: unknown }[] = [];
  let effects: (() => unknown)[] = [];
  let approvalHash = "0xapproval1";
  const { OwnedNftCard } = evaluateModule<{ OwnedNftCard: (props: Record<string, unknown>) => Element }>(
    new URL("../../features/pixel/components/OwnedNftCard.tsx", import.meta.url),
    {
      react: {
        memo: (fn: unknown) => fn,
        useState: () => [firstRender ? "list" : "", () => {}],
        useMemo: (fn: () => unknown) => fn(),
        useCallback: (fn: unknown) => fn,
        useRef: (current: unknown) => refs[refIndex++] ?? (refs[refIndex - 1] = { current }),
        useEffect: (fn: () => unknown) => { effects.push(fn); },
      },
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "next/link": {},
      wagmi: {
        useWriteContract: () => writeIndex++ === 0
          ? { data: approvalHash, writeContractAsync: async () => approvalHash }
          : { isPending: false, writeContractAsync: async () => { attempts++; throw new Error("User rejected"); } },
        useWaitForTransactionReceipt: ({ hash }: { hash?: string }) => ({ data: hash ? { status: "success" } : undefined }),
      },
      viem: { parseEther: () => 1n, formatEther: () => "1" },
      "@/lib/contract": { getExplorerUrl: () => "", getMarketplaceTxUrl: () => "" },
      "@/lib/abi": {},
      "@/lib/marketplaceAbi": {},
      "@/lib/actionLock": { releaseAction: (ref: { current: boolean }) => { ref.current = false; }, tryAcquireAction: () => true },
    },
  );
  const tree = OwnedNftCard({ nft: { tokenId: 1n, imageUrl: "", name: "Test", listing: null }, isPaused: false, onChanged() {} });
  const control = find(tree, (element) => typeof element.type === "function" && "onPriceChange" in element.props)!;
  assert.ok(control);
  firstRender = false;
  const render = async () => {
    writeIndex = 0; refIndex = 0; effects = [];
    (control.type as (props: Record<string, unknown>) => Element)({ ...control.props, price: "1" });
    for (const effect of effects) effect();
    await Promise.resolve();
  };
  await render();
  await render();
  await render();
  assert.equal(attempts, 1, "a rejected request must await a new explicit approval flow");
  approvalHash = "0xapproval2";
  await render();
  assert.equal(attempts, 2, "a later confirmed approval can still start its listing");
});
