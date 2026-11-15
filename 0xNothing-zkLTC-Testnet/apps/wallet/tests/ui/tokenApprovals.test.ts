import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as viem from "viem";
import { evaluateModule } from "../../../web/tests/helpers/evaluateModule.ts";

/**
 * Settings > Token approvals (F19): what the panel reads and what Revoke signs.
 * Only public anvil addresses appear here.
 */
const source = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const panel = source("../../src/ui/screens/settings/TokenApprovals.tsx");

const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const SPENDER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const TOKEN = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";
const HASH = `0x${"ab".repeat(32)}`;

function load(book: Record<string, unknown[]>, network = { id: "custom-77-x", chainId: 77, rpcUrl: "https://rpc.example" }) {
  const reads: string[] = [];
  const client = {
    readContract: async (call: { functionName: string }) => { reads.push(call.functionName); return 5n; },
    multicall: async () => { reads.push("multicall"); return []; },
  };
  const module = evaluateModule<typeof import("../../src/ui/screens/settings/TokenApprovals.tsx")>(
    new URL("../../src/ui/screens/settings/TokenApprovals.tsx", import.meta.url), {
      react: {}, "react/jsx-runtime": {}, viem,
      "../../../abis": { erc20Abi: [] },
      "../../../config/assets": {
        BUILTIN_TOKENS: [], impersonatesBuiltin: () => false, nativeTokenFor: () => ({}),
        customToken: (input: object) => ({ ...input, builtin: false }),
      },
      "../../../config/chain": {}, "../../../config/networks": { isLitvmNetwork: () => false, networkIdentity: () => "" },
      "../../../core/i18n": { t: (key: string) => key }, "../../../core/lib/errors": {}, "../../../core/lib/format": {},
      "../../../core/rpc/client": { publicClientFor: () => client },
      "../../../core/services/approvals": { listApprovalBook: async () => book },
      "../../../core/services/tokens": {
        lookupToken: async () => { reads.push("lookupToken"); return { symbol: "NUSD", name: "NUSD", decimals: 18 }; },
      },
      "../../../core/services/tx": {}, "../../components/kit": {}, "../../components/TokenLogo": {},
      "../../components/TransactionReview": {}, "../../hooks/useActionGate": {}, "../../hooks/useBroadcastHold": {},
      "../../hooks/useLiveRead": {}, "../../lib/requestEffect": {}, "../../lib/reviewKey": {}, "../../router": {},
      "../../state/WalletContext": {},
    },
  );
  return { readApprovalViews: () => module.readApprovalViews(OWNER, network as never), revocable: module.revocable, reads };
}

test("the panel lists only rows of the active chain and makes no read when empty", async () => {
  const row = { token: TOKEN, spender: SPENDER, hash: HASH, at: 1 };
  const empty = load({ 4441: [row] });
  const nothing = await empty.readApprovalViews();
  assert.equal(nothing.rows.length, 0);
  assert.equal(nothing.others, true, "rows of another chain are announced, not shown");
  assert.deepEqual(empty.reads, [], "no RPC read while nothing is recorded here");

  const one = load({ 77: [row] });
  const shown = await one.readApprovalViews();
  assert.equal(shown.others, false);
  assert.equal(shown.rows.length, 1);
  assert.equal(shown.rows[0]?.token, viem.getAddress(TOKEN));
  assert.equal(shown.rows[0]?.spender, viem.getAddress(SPENDER));
  assert.equal(shown.rows[0]?.allowance, 5n);
  // A custom chain reads in turn, no Multicall3 assumed.
  assert.deepEqual([...one.reads].sort(), ["allowance", "lookupToken"]);
});

test("revoke builds approve(recordedSpender, 0n) on the recorded token through TransactionReview", () => {
  assert.match(panel, /address: target\.token,\n\s+abi: erc20Abi,\n\s+functionName: "approve",\n\s+args: \[target\.spender, 0n\],\n\s+kind: "approve",/u);
  // token and spender are the recorded ones, checksummed from storage.
  assert.match(panel, /token,\n\s+spender: getAddress\(record\.spender\),/u);
  assert.match(panel, /<TransactionReview\n\s+title=\{t\("approvals\.reviewTitle"\)\}/u);
  assert.match(panel, /broadcast\.hold\(cause\.hash, sent\)/u);
  // Extension only: Android keeps its Settings and Dapp screens as before.
  assert.match(source("../../src/ui/screens/Settings.tsx"), /\{isExtension \? <TokenApprovals \/> : null\}/u);
  assert.match(source("../../src/ui/screens/Dapps.tsx"), /\{isExtension \? \(\n\s+<Button size="sm" variant="ghost" onClick=\{\(\) => navigate\("settings\?panel=approvals"\)\}>/u);
});

test("Revoke is offered only for a read ERC-20 allowance above zero, never for an NFT or an unreadable row", () => {
  const { revocable } = load({});
  const label = { symbol: "NUSD", decimals: 18 };
  const view = (allowance: bigint | null, token: object | null) => ({ allowance, label: token }) as never;
  assert.equal(revocable(view(5n, label)), true);
  assert.equal(revocable(view(0n, label)), false, "zero: Forget instead");
  assert.equal(revocable(view(null, label)), false, "allowance unreadable");
  // An ERC-721 has no decimals(), so no label, and allowance() reverts.
  assert.equal(revocable(view(null, null)), false, "an NFT approve");
  assert.equal(revocable(view(7n, null)), false, "token unreadable");
  // The button and confirm() both use it.
  assert.ok(panel.includes(") : revocable(view) ? ("));
  assert.ok(panel.includes("if (!revocable(review) || review.networkKey !== networkIdentity(network) || !gate.tryEnter()) return;"));
});

test("the revoke says sent on broadcast and revoked only on a successful receipt", () => {
  const start = panel.indexOf("const sent = (hash: Hex): void => {");
  const sent = panel.slice(start, panel.indexOf("try {", start));
  const lines = sent.split("\n").map((line) => line.trim());
  assert.equal(lines[1], `notify(t("apr.txSent"), "ok", txUrl(hash, submittedNetwork));`);
  assert.ok(lines.includes(`if (receipt.status === "success") notify(t("approvals.revoked"), "ok", txUrl(hash, submittedNetwork));`));
  assert.ok(lines.includes(`else notify(t("err.txReverted"), "error", txUrl(hash, submittedNetwork));`));
  assert.equal(sent.split("approvals.revoked").length, 2, "revoked is said once, on the receipt");
});

test("an open revoke review closes when the account or network changes", () => {
  const flat = panel.replace(/\s+/gu, " ");
  assert.ok(flat.includes("useEffect(() => { setReview(null); }, [address, network.id, network.rpcUrl]);"));
  assert.ok(flat.includes("setReview({ ...view, networkKey: networkIdentity(network) });"));
});
