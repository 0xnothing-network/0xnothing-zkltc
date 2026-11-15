import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { foldConfusables } from "../../src/core/lib/confusables.ts";
import { parseAddChain, parseWatchAsset, safeProposedChain, safeWatchAsset } from "../../src/core/lib/dappProposals.ts";
import { type DappRequest, planPendingAdmission, sanitizePendingRequests } from "../../src/core/services/dapp.ts";
import { isBoundedRpcCall } from "../../src/extension/protocol.ts";

// wallet_watchAsset (F5) and wallet_addEthereumChain (F11): page text checked in
// the worker, again when the queued row is read back, and shown as checked.
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const background = source("../../src/extension/background.ts");
const approve = source("../../src/ui/screens/Approve.tsx");
const TOKEN = `0x${"ab".repeat(20)}`;
const ACCOUNT = `0x${"11".repeat(20)}` as const;

function body(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  assert.ok(from >= 0, start);
  return text.slice(from, text.indexOf(end, from + start.length));
}

test("watchAsset params are accepted as an object or a one-element array", () => {
  const options = { address: TOKEN.toUpperCase().replace("0X", "0x"), symbol: "TKN", decimals: 18 };
  const expected = { asset: { address: TOKEN, symbol: "TKN", decimals: 18 } };
  assert.deepEqual(parseWatchAsset({ type: "ERC20", options }, 4441n), expected);
  assert.deepEqual(parseWatchAsset([{ type: "ERC20", options }], 4441n), expected);
  assert.deepEqual(parseWatchAsset({ type: "ERC20", options: { address: TOKEN, decimals: "6" } }, 4441n), {
    asset: { address: TOKEN, decimals: 6 },
  });
  for (const params of [null, [], [{}, {}], "x", { type: "ERC20" }, { type: "ERC20", options: [] }]) {
    assert.ok("error" in parseWatchAsset(params, 4441n), JSON.stringify(params));
  }
});

test("only ERC20 with a valid address is accepted; long, control or bidi symbols and decimals outside 0..36 are refused", () => {
  const bad = [
    { type: "ERC721", options: { address: TOKEN } },
    { type: "erc20", options: { address: TOKEN } },
    { type: "ERC20", options: { address: `0x${"0".repeat(40)}` } },
    { type: "ERC20", options: { address: "0x1234" } },
    { type: "ERC20", options: { address: TOKEN, symbol: "A".repeat(12) } },
    { type: "ERC20", options: { address: TOKEN, symbol: "A".repeat(30) } },
    { type: "ERC20", options: { address: TOKEN, symbol: "  " } },
    { type: "ERC20", options: { address: TOKEN, symbol: "NU\nSD" } },
    { type: "ERC20", options: { address: TOKEN, symbol: "\u202eDSUN" } },
    { type: "ERC20", options: { address: TOKEN, symbol: 5 } },
    { type: "ERC20", options: { address: TOKEN, decimals: 37 } },
    { type: "ERC20", options: { address: TOKEN, decimals: -1 } },
    { type: "ERC20", options: { address: TOKEN, decimals: 1.5 } },
    { type: "ERC20", options: { address: TOKEN, decimals: 1e9 } },
    { type: "ERC20", options: { address: TOKEN, decimals: "0x12" } },
  ];
  for (const params of bad) assert.ok("error" in parseWatchAsset(params, 4441n), JSON.stringify(params));
  assert.ok("asset" in parseWatchAsset({ type: "ERC20", options: { address: TOKEN, symbol: " ABCDEFGHIJK ", decimals: 36 } }, 4441n));
});

test("a token chainId other than the active network is refused", () => {
  const params = (chainId: unknown) => ({ type: "ERC20", options: { address: TOKEN, chainId } });
  assert.ok("asset" in parseWatchAsset(params("0x1159"), 4441n));
  assert.ok("asset" in parseWatchAsset(params(4441), 4441n));
  for (const chainId of ["0x1", 1, "nope", null]) {
    assert.deepEqual(parseWatchAsset(params(chainId), 4441n), { error: "The token's chainId does not match the active network" });
  }
});

test("image and unknown fields never reach the row", () => {
  const parsed = parseWatchAsset({
    type: "ERC20",
    options: { address: TOKEN, symbol: "TKN", image: "https://tracker.example/p.png", extra: 1 },
  }, 4441n);
  assert.deepEqual(parsed, { asset: { address: TOKEN, symbol: "TKN" } });
  assert.deepEqual(safeWatchAsset({ address: TOKEN, image: "https://tracker.example/p.png" }), { address: TOKEN });
  // A stored row is re-checked: upper case or an over-long symbol was not written by the worker.
  assert.equal(safeWatchAsset({ address: TOKEN.toUpperCase().replace("0X", "0x") }), null);
  assert.equal(safeWatchAsset({ address: TOKEN, symbol: "X".repeat(12) }), null);
});

const base = {
  chainId: "0x2105",
  chainName: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://mainnet.base.org"],
  blockExplorerUrls: ["https://basescan.org/"],
};

test("a proposal needs a chainId, a clean name, a currency and a public https RPC", () => {
  assert.deepEqual(parseAddChain([base]), {
    chain: {
      chainId: 8453, name: "Base", currencyName: "Ether", symbol: "ETH", decimals: 18,
      rpcUrl: "https://mainnet.base.org/", explorerUrl: "https://basescan.org",
    },
  });
  const without = (patch: Record<string, unknown>) => parseAddChain([{ ...base, ...patch }]);
  for (const patch of [
    { chainId: undefined }, { chainId: "0x0" }, { chainId: "base" }, { chainId: `0x${"f".repeat(16)}` },
    { chainName: undefined }, { chainName: "" }, { chainName: "B".repeat(49) }, { chainName: "Base\u200e" }, { chainName: "Ba\nse" },
    { nativeCurrency: undefined }, { nativeCurrency: { name: "Ether", symbol: "ETH" } },
    { nativeCurrency: { name: "Ether", symbol: "E".repeat(13), decimals: 18 } },
    { nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 37 } },
    { rpcUrls: undefined }, { rpcUrls: [] }, { rpcUrls: Array(9).fill("https://a.example") }, { rpcUrls: [5] },
    { blockExplorerUrls: ["javascript:alert(1)"] }, { blockExplorerUrls: ["http://basescan.org"] }, { blockExplorerUrls: "https://x.example" },
  ]) {
    assert.ok("error" in without(patch), JSON.stringify(patch));
  }
  assert.ok("error" in parseAddChain(base), "params must be an array");
  assert.ok("error" in parseAddChain([]), "empty params");
  // No explorer is allowed and saved as none.
  const bare = parseAddChain([{ ...base, blockExplorerUrls: undefined }]);
  assert.ok("chain" in bare && bare.chain.explorerUrl === "");
});

test("only rpcUrls[0] is used; http, IP literals, localhost and private hosts are refused", () => {
  const second = parseAddChain([{ ...base, rpcUrls: ["https://mainnet.base.org", "https://other.example"] }]);
  assert.ok("chain" in second && second.chain.rpcUrl === "https://mainnet.base.org/");
  for (const rpc of [
    "http://mainnet.base.org", "http://127.0.0.1:8545", "https://127.0.0.1:8545", "https://[::1]:8545", "https://10.0.0.1",
    "https://2130706433", "https://localhost:8545", "https://node.localhost", "https://router.local", "https://rpc.internal",
    "https://nas.home.arpa", "https://localhost.", "https://user:pass@rpc.example", "wss://rpc.example", "javascript:alert(1)",
  ]) {
    assert.deepEqual(parseAddChain([{ ...base, rpcUrls: [rpc, "https://mainnet.base.org"] }]), {
      error: "Only a public https RPC URL can be proposed",
    }, rpc);
  }
});

test("names folding to LitVM or LiteForge and the symbol zkLTC are reserved", () => {
  for (const chainName of ["LiteForge 2", "LitVM", "litvm mainnet", "L1teF0rge", "LіtВM".replace("В", "V"),"\uff2c\uff49\uff54\uff36\uff2d"]) {
    assert.deepEqual(parseAddChain([{ ...base, chainName }]), { error: "This network name is reserved" }, chainName);
  }
  for (const symbol of ["zkLTC", "ZKLTC", "zkⅼTC"]) {
    assert.deepEqual(parseAddChain([{ ...base, nativeCurrency: { name: "X", symbol, decimals: 18 } }]), {
      error: "This currency symbol is reserved",
    }, symbol);
  }
  assert.ok("chain" in parseAddChain([{ ...base, chainName: "Litecoin EVM" }]));
  assert.equal(foldConfusables("0xNothing"), "oxnothlng");
});

test("invisible characters, spaces and hyphens do not get a reserved name, currency name or symbol through", () => {
  // Zero-width space, soft hyphen, word joiner, zero-width joiner: each displays
  // as nothing, so the label reads exactly as the reserved one.
  for (const chainName of ["Lite\u200bForge Testnet", "L\u00aditeForge", "Lit\u2060VM", "Lite\u200dForge", "Lit\ufeffVM"]) {
    assert.deepEqual(parseAddChain([{ ...base, chainName }]), { error: "The network name is not valid" }, chainName);
  }
  for (const chainName of ["Lite Forge", "Lit-VM", "lite_forge", "Lit.VM mainnet"]) {
    assert.deepEqual(parseAddChain([{ ...base, chainName }]), { error: "This network name is reserved" }, chainName);
  }
  for (const symbol of ["zk\u200bLTC", "zkL\u2060TC", "zk\u00adLTC"]) {
    assert.deepEqual(parseAddChain([{ ...base, nativeCurrency: { name: "X", symbol, decimals: 18 } }]), {
      error: "The native currency is not valid",
    }, symbol);
  }
  for (const symbol of ["zk LTC", "zk-LTC", "ZK.LTC"]) {
    assert.deepEqual(parseAddChain([{ ...base, nativeCurrency: { name: "X", symbol, decimals: 18 } }]), {
      error: "This currency symbol is reserved",
    }, symbol);
  }
  for (const name of ["LitVM", "Lite Forge Ether", "Lit-VM gas"]) {
    assert.deepEqual(parseAddChain([{ ...base, nativeCurrency: { name, symbol: "ETH", decimals: 18 } }]), {
      error: "This currency name is reserved",
    }, name);
  }
  // A watched token's symbol follows the same label rule.
  assert.deepEqual(parseWatchAsset({ type: "ERC20", options: { address: TOKEN, symbol: "NU\u200bSD" } }, 4441n), {
    error: "The token symbol is not valid",
  });
  assert.ok("chain" in parseAddChain([{ ...base, chainName: "Base Sepolia", nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 } }]));
});

test("a Hangul filler, a letter drawn as a blank gap, does not get a reserved name or symbol through", () => {
  for (const filler of [0x115f, 0x1160, 0x3164, 0xffa0]) {
    const gap = String.fromCodePoint(filler);
    const label = filler.toString(16);
    // "Lite<filler>Forge" displays as "Lite Forge", which the plain space already gets refused.
    assert.deepEqual(parseAddChain([{ ...base, chainName: `Lite${gap}Forge` }]), {
      error: "The network name is not valid",
    }, label);
    assert.deepEqual(parseAddChain([{ ...base, nativeCurrency: { name: "X", symbol: `zk${gap}LTC`, decimals: 18 } }]), {
      error: "The native currency is not valid",
    }, label);
    assert.deepEqual(parseAddChain([{ ...base, nativeCurrency: { name: `Lit${gap}VM gas`, symbol: "ETH", decimals: 18 } }]), {
      error: "The native currency is not valid",
    }, label);
    assert.deepEqual(parseWatchAsset({ type: "ERC20", options: { address: TOKEN, symbol: `NU${gap}SD` } }, 4441n), {
      error: "The token symbol is not valid",
    }, label);
    // A stored row is read back with the same rule.
    assert.equal(safeWatchAsset({ address: TOKEN.toLowerCase(), symbol: `NU${gap}SD` }), null, label);
  }
  // Real Hangul text is still a valid label.
  assert.ok("chain" in parseAddChain([{ ...base, chainName: "한국 테스트넷" }]));
});

test("a host with no dot or a private suffix is not a public RPC", () => {
  for (const rpc of ["https://intranet", "https://intranet.", "https://rpc/", "https://nas.lan", "https://git.corp", "https://box.home"]) {
    assert.deepEqual(parseAddChain([{ ...base, rpcUrls: [rpc] }]), {
      error: "Only a public https RPC URL can be proposed",
    }, rpc);
  }
  assert.ok("chain" in parseAddChain([{ ...base, rpcUrls: ["https://rpc.homes.example"] }]));
});

test("iconUrls never reach the row, and a stored proposal is checked again", () => {
  const parsed = parseAddChain([{ ...base, iconUrls: ["https://tracker.example/i.png"], extra: true }]);
  assert.ok("chain" in parsed);
  assert.deepEqual(Object.keys(parsed.chain).sort(), ["chainId", "currencyName", "decimals", "explorerUrl", "name", "rpcUrl", "symbol"]);
  assert.deepEqual(safeProposedChain(parsed.chain), parsed.chain);
  assert.equal(safeProposedChain({ ...parsed.chain, rpcUrl: "https://mainnet.base.org" }), null, "not normalized");
  assert.equal(safeProposedChain({ ...parsed.chain, rpcUrl: "http://127.0.0.1:8545/" }), null);
  assert.equal(safeProposedChain({ ...parsed.chain, name: "LiteForge" }), null);
  assert.equal(safeProposedChain({ ...parsed.chain, chainId: "0x2105" }), null);
});

test("object params pass the page boundary only for wallet_watchAsset", () => {
  const params = { type: "ERC20", options: { address: TOKEN } };
  assert.equal(isBoundedRpcCall({ method: "wallet_watchAsset", params }), true);
  assert.equal(isBoundedRpcCall({ method: "wallet_watchAsset", params: [params] }), true);
  assert.equal(isBoundedRpcCall({ method: "eth_call", params }), false);
  assert.equal(isBoundedRpcCall({ method: "wallet_addEthereumChain", params: base }), false);
  assert.equal(isBoundedRpcCall({ method: "wallet_watchAsset", params: null }), false);
  assert.equal(isBoundedRpcCall({ method: "wallet_watchAsset", params: new Date() }), false);
  assert.equal(isBoundedRpcCall({ method: "wallet_watchAsset", params: "ERC20" }), false);
});

function row(id: string, kind: DappRequest["kind"], extra: Partial<DappRequest> = {}, origin = "https://app.example"): DappRequest {
  return { id, origin, kind, at: 1_000_000, account: ACCOUNT, ...extra };
}

const chain = { chainId: 8453, name: "Base", currencyName: "Ether", symbol: "ETH", decimals: 18, rpcUrl: "https://mainnet.base.org/", explorerUrl: "" };

test("queued proposals without a valid asset or chain are dropped on read; on another kind they are ignored", () => {
  const rows = sanitizePendingRequests([
    row("asset-ok", "watch-asset", { asset: { address: TOKEN as `0x${string}`, symbol: "TKN" } }),
    row("asset-missing", "watch-asset"),
    row("asset-bad", "watch-asset", { asset: { address: TOKEN as `0x${string}`, symbol: "\u202eX" } }),
    row("chain-ok", "add-network", { chain }),
    row("chain-missing", "add-network"),
    row("chain-bad", "add-network", { chain: { ...chain, rpcUrl: "http://127.0.0.1:8545/" } }),
    row("sign", "sign", { message: "hi", asset: { address: TOKEN as `0x${string}` }, chain }),
  ]);
  assert.deepEqual(rows.map((entry) => entry.id), ["asset-ok", "chain-ok", "sign"]);
  assert.equal(rows[2]!.asset, undefined);
  assert.equal(rows[2]!.chain, undefined);
  assert.deepEqual(rows[1]!.chain, chain);
});

test("a second watch-asset for the same token, or a second proposal, from one origin is refused; caps still count them", () => {
  const asset = { address: TOKEN as `0x${string}` };
  const queue = [row("a", "watch-asset", { asset }), row("n", "add-network", { chain })];
  assert.deepEqual(planPendingAdmission(queue, row("b", "watch-asset", { asset }), 1_000_001), { accepted: false, reason: "duplicate-asset" });
  assert.deepEqual(planPendingAdmission(queue, row("m", "add-network", { chain }), 1_000_001), { accepted: false, reason: "duplicate-network" });
  // Another token, or another site, is admitted.
  assert.equal(planPendingAdmission(queue, row("c", "watch-asset", { asset: { address: `0x${"cd".repeat(20)}` as `0x${string}` } }), 1_000_001).accepted, true);
  assert.equal(planPendingAdmission(queue, row("d", "add-network", { chain }, "https://other.example"), 1_000_001).accepted, true);
  // The per-origin cap counts them like any row.
  const full = [...queue, row("t1", "sign", { message: "x" }), row("t2", "sign", { message: "y" })];
  assert.deepEqual(
    planPendingAdmission(full, row("e", "watch-asset", { asset: { address: `0x${"ef".repeat(20)}` as `0x${string}` } }), 1_000_001),
    { accepted: false, reason: "origin-limit" },
  );
});

test("watchAsset and addEthereumChain are answered after the connection check", () => {
  const handle = body(background, "async function handle(", "\nchrome.runtime.onMessage");
  const check = handle.indexOf('if (!account) return fail(4100, "This site is not connected to the wallet");');
  assert.ok(check > 0);
  assert.ok(handle.indexOf('if (method === "wallet_watchAsset") {') > check);
  assert.ok(handle.indexOf('if (method === "wallet_addEthereumChain") {') > check);
  assert.equal(handle.indexOf('"wallet_watchAsset") return'), -1, "no early answer before the check");
});

test("a built-in token answers true and a saved chain answers null, both without a prompt", () => {
  const watch = body(background, 'if (method === "wallet_watchAsset") {', 'if (method === "wallet_addEthereumChain") {');
  assert.ok(watch.indexOf("BUILTIN_TOKEN_ADDRESSES.has(parsed.asset.address)) return { result: true };") < watch.indexOf("askUser("));
  assert.match(watch, /return answer\.error \? answer : \{ result: true \};/u);
  const add = body(background, 'if (method === "wallet_addEthereumChain") {', 'if (method === "wallet_switchEthereumChain") {');
  assert.ok(add.indexOf("if (await savedNetworkForChain(BigInt(parsed.chain.chainId))) return { result: null };") < add.indexOf("askUser("));
  assert.match(add, /return answer\.error \? answer : \{ result: null \};/u);
  // Adding never switches: that is the switch request's own approval.
  assert.doesNotMatch(add, /switchNetwork|targetNetworkId/u);
  assert.match(add, /MAX_CUSTOM_NETWORKS/u);
  // Every other method reads array params only.
  assert.match(background, /const params = Array\.isArray\(call\.params\) \? call\.params : \[\];/u);
});

test("the approval keeps Approve disabled until the token was read and the RPC answered the proposed chain", () => {
  assert.match(approve, /const chainBlocked = request\?\.kind === "add-network" && \(chain === null \|\| probeState !== "verified"\);/u);
  assert.match(approve, /\|\| riskBlocked \|\| assetBlocked \|\| chainBlocked \|\| capError !== null\n/u);
  assert.match(approve, /asset === null\n\s+\|\| assetMeta == null\n/u);
  // The host permission is asked inside the click, before the first await of approve().
  const click = body(approve, "const approve = async (): Promise<void> => {", "const reject = async");
  const ask = click.indexOf("requestRpcPermission(request.chain.rpcUrl)");
  assert.ok(ask > 0 && ask < click.indexOf("await "), "asked before any await");
  const retry = body(approve, "const checkAgain = (): void => {", "const preview = useLiveRead(");
  assert.ok(retry.indexOf("requestRpcPermission(chain.rpcUrl)") < retry.indexOf("probe.reload()"));
  // What is shown comes from the chain or the checked proposal, never from the page's image.
  assert.doesNotMatch(approve, /\.image\b|iconUrls/u);
  assert.match(approve, /lookupToken\(asset\.address, network\)/u);
});
