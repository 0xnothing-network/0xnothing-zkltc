import assert from "node:assert/strict";
import test from "node:test";
import * as viem from "viem";
import * as marketplace from "../../lib/nusdMarketplace.ts";
import * as marketplaceView from "../../lib/nusdMarketplaceView.ts";
import { getPixelImageUrl } from "../../lib/pixelImage.ts";
import type { ProtocolCall, ProtocolStage } from "../../features/fi/lib/hooks/useProtocolTransaction.ts";
import { evaluateModule } from "../helpers/evaluateModule.ts";

type Element = { type: unknown; props: Record<string, unknown> };
const jsx = (type: unknown, props: Record<string, unknown>): Element => ({ type, props });
const MARKET = "0x0000000000000000000000000000000000000011" as const;
const NUSD = "0x0000000000000000000000000000000000000022" as const;
const NFT = "0x0000000000000000000000000000000000000033" as const;
const BUYER = "0x0000000000000000000000000000000000000044" as const;
const SELLER = "0x0000000000000000000000000000000000000055" as const;
const OTHER = "0x0000000000000000000000000000000000000066" as const;
const UNIT = 10n ** 18n;

function find(root: unknown, predicate: (value: Element) => boolean): Element | undefined {
  if (Array.isArray(root)) return root.map((child) => find(child, predicate)).find(Boolean);
  if (!root || typeof root !== "object" || !("props" in root)) return undefined;
  const element = root as Element;
  return predicate(element) ? element : find(element.props.children, predicate);
}

function content(root: unknown): string {
  if (Array.isArray(root)) return root.map(content).join("");
  if (typeof root === "string" || typeof root === "number") return String(root);
  if (root && typeof root === "object" && "props" in root) return content((root as Element).props.children);
  return "";
}

function harness(options: { configured?: boolean; credit?: bigint; balance?: bigint; paused?: boolean; seller?: boolean; changeAt?: "refresh" | "approval" | "quote" | "listing"; changeKind?: "address" | "chain" | "connector"; stale?: boolean; error?: boolean; listingForm?: boolean; existingListing?: boolean; loading?: boolean; empty?: boolean; disconnected?: boolean; chainId?: number; metadataFailure?: boolean; rejected?: boolean } = {}) {
  const account = { isConnected: !options.disconnected, address: options.disconnected ? undefined : options.seller ? SELLER as viem.Address : BUYER as viem.Address, chainId: options.chainId ?? 4441, connector: { uid: "wallet-a" } };
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  const state = {
    blockNumber: 900n, timestamp, readAt: Date.now() - (options.stale ? 61000 : 0), paused: options.paused ?? false,
    feeBps: 40, listingCount: 1n, offerCount: 1n, volume: 0n, escrow: 100n * UNIT, catalogueComplete: true,
    credit: options.credit ?? 40n * UNIT, balance: options.balance ?? 60n * UNIT,
    listings: options.empty ? [] : [{ id: 1n, collection: NFT, tokenId: 3n, price: 100n * UNIT, seller: SELLER, active: true }],
    offers: options.empty ? [] : [{ id: 2n, collection: NFT, tokenId: 3n, offerer: BUYER, price: 100n * UNIT, expiresAt: timestamp + 3600n, active: true, owner: SELLER }],
  };
  const calls: { call?: ProtocolCall; approval?: { token: viem.Address; spender: viem.Address; amount: bigint }; stages?: ProtocolStage[] }[] = [];
  const reads: { functionName: string; args?: readonly unknown[] }[] = [];
  const queryOptions: { enabled: boolean }[] = [];
  const states: unknown[] = [], refs: { current: unknown }[] = [];
  let stateIndex = 0, refIndex = 0, refreshes = 0, invalidations = 0;
  function changeWallet() {
    if (options.changeKind === "chain") account.chainId = 1;
    else if (options.changeKind === "connector") account.connector = { uid: "wallet-b" };
    else account.address = OTHER;
  }
  const { createWalletSessionGuard } = evaluateModule<{ createWalletSessionGuard: (config: unknown, address: viem.Address, chainId: number) => () => void }>(
    new URL("../../lib/walletSession.ts", import.meta.url), { "wagmi/actions": { getAccount: () => account } }, { Error },
  );
  const client = {
    readContract: async (call: typeof reads[number]) => {
      reads.push(call);
      if ((options.changeAt === "approval" && call.functionName === "getApproved") || (options.changeAt === "quote" && call.functionName === "quoteSale") || (options.changeAt === "listing" && call.functionName === "listings")) changeWallet();
      if (call.functionName === "listings") return [NFT, 3n, 100n * UNIT, SELLER, true];
      if (call.functionName === "quoteSale") return [UNIT * 4n / 10n, OTHER, 5n * UNIT, 946n * UNIT / 10n];
      if (call.functionName === "getApproved") return viem.zeroAddress;
      if (call.functionName === "isApprovedForAll") return false;
      if (call.functionName === "collectionAllowed") return true;
      throw new Error(`Unexpected read: ${call.functionName}`);
    },
  };
  const transaction = { pending: false, message: "", phase: "idle", hash: undefined, reset() {}, execute: async (call: typeof calls[number]) => { calls.push(call); if (options.rejected) throw new Error("User rejected"); return "0xconfirmed"; } };
  const { NusdMarketplaceDashboard } = evaluateModule<{ NusdMarketplaceDashboard: (props?: { initialTokenKey: string }) => Element }>(new URL("../../features/pixel/components/NusdMarketplaceDashboard.tsx", import.meta.url), {
    "next/link": { default: "a" }, "next/image": { default: "img" }, "react/jsx-runtime": { jsx, jsxs: jsx },
    "@phosphor-icons/react": Object.fromEntries(["ArrowDown", "ArrowRight", "ArrowUpRight", "ArrowsClockwise", "Clock", "Coins", "ImageSquare", "MagnifyingGlass", "Plus", "ShieldCheck", "Stack", "Wallet"].map((name) => [name, "svg"])),
    react: {
      useState: (initial: unknown) => { const index = stateIndex++; if (!(index in states)) states[index] = initial; return [states[index], (next: unknown) => { states[index] = typeof next === "function" ? next(states[index]) : next; }]; },
      useRef: (initial: unknown) => refs[refIndex++] ?? (refs[refIndex - 1] = { current: initial }),
      useEffect: () => {},
    },
    "@tanstack/react-query": { useQueryClient: () => ({ invalidateQueries: async () => { invalidations += 1; } }), useQuery: (query: { enabled: boolean; queryKey: readonly unknown[] }) => {
      queryOptions.push(query);
      const marketQuery = query.queryKey[0] === "pixel-nusd-market";
      if (query.queryKey[0] === "pixel-nusd-artwork") return { data: { tokens: { [`${NFT}:3`]: { name: "NUSD artwork" } }, failed: options.metadataFailure ? 1 : 0 }, isError: false };
      const owned = options.listingForm ? [{ collection: NFT, tokenId: "3", name: "NUSD artwork", listing: options.existingListing ? { listingId: "1", price: (100n * UNIT).toString() } : null }] : [];
      return { data: marketQuery ? options.loading ? undefined : state : owned, isError: marketQuery && options.error, isFetching: marketQuery && options.loading, refetch: async () => { if (marketQuery) { refreshes += 1; if (options.changeAt === "refresh") changeWallet(); } return { data: marketQuery ? state : owned, isError: options.error }; } };
    } },
    wagmi: { useAccount: () => ({ ...account }), useConfig: () => ({}), usePublicClient: () => client, useConnect: () => ({}), useSwitchChain: () => ({}) },
    viem, "@fi/lib/hooks/useProtocolTransaction": { useProtocolTransaction: () => transaction },
    "@/lib/contract": { getAddressExplorerUrl: (address: string) => `/address/${address}`, getMarketplaceTxUrl: () => "", getTokenExplorerUrl: () => "", shortenAddress: (address: string) => address },
    "@/lib/nusdMarketplaceConfig": { NFT_NUSD_ADDRESS: NUSD, NUSD_MARKETPLACE_ADDRESS: options.configured === false ? undefined : MARKET },
    "@/lib/nusdMarketplace": marketplace, "@/lib/nusdMarketplaceView": marketplaceView, "@/lib/pixelImage": { getPixelImageUrl }, "@/lib/http": {}, "@/lib/walletSession": { createWalletSessionGuard }, "./NusdMarketplaceDashboard.module.css": { default: {} }, "./NusdMarketplaceActivity": { NusdMarketplaceActivity: "activity" },
  }, { Error });
  function render() { stateIndex = 0; refIndex = 0; return NusdMarketplaceDashboard({ initialTokenKey: options.listingForm ? `${NFT.toLowerCase()}:3` : "" }); }
  function button(label: string) {
    const element = find(render(), (value) => value.type === "button" && content(value.props.children).startsWith(label));
    assert.ok(element, `Missing button ${label}`);
    return element;
  }
  async function settle() {
    for (let step = 0; step < 30; step++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (!refs[0]?.current) return;
    }
    throw new Error("Action did not settle");
  }
  async function click(label: string) { const element = button(label); assert.ok(!element.props.disabled); (element.props.onClick as () => void)(); await settle(); }
  return { account, state, calls, reads, queryOptions, states, render, button, click, settle, refreshes: () => refreshes, invalidations: () => invalidations };
}

test("unconfigured NUSD marketplace is explicitly gated and never offers a transaction", () => {
  const market = harness({ configured: false });
  const tree = market.render();
  assert.match(content(tree), /not deployed/);
  assert.ok(!find(tree, (value) => value.type === "button"));
  assert.ok(market.queryOptions.every((query) => !query.enabled));
  assert.equal(market.calls.length, 0);
});

test("art-first listing cards use actual collection artwork and disclose wallet funding", () => {
  const market = harness();
  const tree = market.render();
  const card = find(tree, (element) => element.type === "article" && element.props["aria-label"] === "NUSD artwork");
  assert.ok(card);
  const preview = find(card, (element) => typeof element.type === "function" && element.type.name === "ArtworkPreview");
  assert.equal(preview?.props.collection, NFT);
  assert.equal(preview?.props.tokenId, 3n);
  assert.match(content(card), /From marketplace credits40 NUSDFrom your wallet60 NUSD/);
  assert.match(content(tree), /Search and sort all active listings/);
  const contractLink = find(tree, (element) => element.type === "a" && content(element.props.children) === "Market contract");
  assert.equal(contractLink?.props.href, `/address/${MARKET}`);
});

test("the trade desk has an honest empty preview and explains a disabled listing action", () => {
  const market = harness();
  const tree = market.render();
  const preview = find(tree, (element) => element.type === "aside" && element.props["aria-label"] === "Selected artwork preview");
  assert.ok(preview);
  assert.match(content(preview), /Choose an artwork/);
  assert.ok(!find(preview, (element) => typeof element.type === "function" && element.type.name === "ArtworkPreview"));
  assert.match(content(tree), /Choose your artwork to prepare a listing/);
  assert.equal(market.button("Approve NFT and list").props.disabled, true);
  const steps = find(tree, (element) => element.type === "ol" && element.props["aria-label"] === "Trade preparation");
  assert.ok(find(steps, (element) => element.type === "li" && element.props["aria-current"] === "step" && content(element.props.children) === "01Artwork"));
  assert.equal(market.calls.length, 0);
});

test("wallet thumbnails select real artwork without signing and drive the large trade preview", () => {
  const market = harness({ listingForm: true, seller: true });
  market.render();
  market.states[3] = "";
  const picker = find(market.render(), (element) => element.props["aria-label"] === "Quick select wallet artwork");
  const thumbnail = find(picker, (element) => element.type === "button" && element.props["aria-label"] === "Select NUSD artwork");
  assert.ok(thumbnail);
  (thumbnail.props.onClick as () => void)();
  const preview = find(market.render(), (element) => element.props["aria-label"] === "Selected artwork preview");
  const artwork = find(preview, (element) => typeof element.type === "function" && element.type.name === "ArtworkPreview");
  assert.equal(artwork?.props.collection, NFT);
  assert.equal(artwork?.props.tokenId, "3");
  assert.equal(artwork?.props.name, "NUSD artwork");
  assert.ok(!artwork?.props.compact);
  assert.equal(market.states[3], `${NFT}:3`);
  assert.equal(market.calls.length, 0);
});

test("listing review retains wei precision and does not invent a royalty or net sale estimate", () => {
  const market = harness({ listingForm: true, seller: true });
  market.render();
  market.states[4] = "100.000000000000000001";
  const form = find(market.render(), (element) => element.props.id === "sell-nusd");
  assert.match(content(form), /Platform fee \(0\.4%\)0\.4 NUSD/);
  assert.match(content(form), /Creator royaltyCalculated at sale/);
  assert.doesNotMatch(content(form), /Net proceeds|Guaranteed/);
  const preview = find(market.render(), (element) => element.props["aria-label"] === "Selected artwork preview");
  assert.match(content(preview), /100\.000000000000000001NUSD/);
  market.states[4] = "invalid";
  assert.equal(market.button("Approve NFT and list").props.disabled, true);
  assert.match(content(market.render()), /Enter a positive NUSD price to continue/);
});

test("offer presets change expiry while the preview keeps the actual listing price", async () => {
  const market = harness();
  const offer = find(market.render(), (element) => element.type === "a" && element.props.href === "#offer-nusd")!;
  (offer.props.onClick as () => void)();
  market.states[6] = "80";
  const preview = find(market.render(), (element) => element.props["aria-label"] === "Selected artwork preview");
  assert.match(content(preview), /Current listing100NUSD/);
  const preset = market.button("7 days");
  assert.equal(preset.props.type, "button");
  (preset.props.onClick as () => void)();
  assert.equal(market.states[7], "168");
  const form = find(market.render(), (element) => element.props.id === "offer-nusd")!;
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} });
  await market.settle();
  assert.equal(market.calls[0].call?.functionName, "makeOffer");
  assert.equal(market.calls[0].call?.args?.[3], market.state.timestamp + 168n * 3600n);
  assert.equal(market.calls[0].approval?.amount, 40n * UNIT);
});

test("disconnected and wrong-chain wallets cannot trade; balances are not fabricated", () => {
  const disconnected = harness({ disconnected: true });
  assert.equal(disconnected.button("Buy with NUSD").props.disabled, true);
  assert.match(content(disconnected.render()), /Not connectedSpendable NUSD—NUSD/);
  const wrongChain = harness({ chainId: 1 });
  assert.equal(wrongChain.button("Buy with NUSD").props.disabled, true);
  assert.ok(!find(wrongChain.render(), (element) => element.type === "button" && content(element.props.children).startsWith("Withdraw")));
  assert.ok(wrongChain.button("Switch to LiteForge 4441"));
});

test("loading, empty and metadata failure states keep inventory honest", () => {
  const loading = harness({ loading: true });
  const loadingTree = loading.render();
  assert.ok(find(loadingTree, (element) => element.props["aria-label"] === "Loading listings"));
  assert.ok(!find(loadingTree, (element) => element.type === "article"));
  const empty = harness({ empty: true });
  assert.match(content(empty.render()), /No artworks listed/);
  assert.ok(!find(empty.render(), (element) => element.type === "article"));
  const partial = harness({ metadataFailure: true });
  assert.match(content(partial.render()), /Some NFT names are unavailable/);
  assert.equal(partial.button("Buy with NUSD").props.disabled, false);
});

test("search filters the catalogue and clearing filters restores cards", async () => {
  const market = harness();
  const search = find(market.render(), (element) => element.type === "input" && element.props.type === "search");
  assert.ok(search);
  (search.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "missing artwork" } });
  assert.ok(!find(market.render(), (element) => element.type === "article"));
  assert.match(content(market.render()), /No matching NFTs/);
  await market.click("Clear filters");
  assert.ok(find(market.render(), (element) => element.type === "article"));
  assert.equal(market.calls.length, 0);
});

test("a selected collection remains explicit when a refreshed page has no matching listings", () => {
  const market = harness();
  const label = find(market.render(), (element) => element.type === "label" && content(element.props.children).startsWith("Collections"));
  const select = find(label, (element) => element.type === "select");
  assert.ok(select);
  (select.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: NFT.toLowerCase() } });
  market.state.listings = [];
  const selected = find(market.render(), (element) => element.type === "select" && element.props.value === NFT.toLowerCase());
  assert.ok(selected);
  assert.ok(find(selected, (element) => element.type === "option" && element.props.value === NFT.toLowerCase()));
});

test("listing offer action preselects its NFT and reveals the offer form", () => {
  const market = harness();
  const tree = market.render();
  const offer = find(tree, (element) => element.type === "a" && element.props.href === "#offer-nusd");
  assert.ok(offer);
  (offer.props.onClick as () => void)();
  const offerForm = find(market.render(), (element) => element.props.id === "offer-nusd");
  const sellForm = find(market.render(), (element) => element.props.id === "sell-nusd");
  assert.equal(offerForm?.props.hidden, false);
  assert.equal(sellForm?.props.hidden, true);
  const select = find(offerForm, (element) => element.type === "select");
  assert.equal(select?.props.value, "1");
  assert.equal(market.calls.length, 0);
});

test("artwork errors show an accessible fallback without disabling chain-authoritative trading", () => {
  const market = harness();
  const card = find(market.render(), (element) => element.type === "article");
  const preview = find(card, (element) => typeof element.type === "function" && element.type.name === "ArtworkPreview");
  assert.ok(preview && typeof preview.type === "function");
  const renderPreview = preview.type as (props: Record<string, unknown>) => Element;
  const image = find(renderPreview(preview.props), (element) => element.type === "img");
  assert.equal(image?.props.src, getPixelImageUrl(3n, NFT));
  assert.equal(image?.props.alt, "NUSD artwork");
  (image?.props.onError as () => void)();
  market.render();
  assert.match(content(renderPreview(preview.props)), /Image unavailable/);
  assert.equal(market.button("Buy with NUSD").props.disabled, false);
});

test("offer workflow previews exact funding and signs only the wallet shortfall", async () => {
  const market = harness();
  const offer = find(market.render(), (element) => element.type === "a" && element.props.href === "#offer-nusd");
  assert.ok(offer);
  (offer.props.onClick as () => void)();
  market.states[6] = "80";
  const form = find(market.render(), (element) => element.props.id === "offer-nusd");
  assert.ok(form);
  assert.match(content(form), /Use marketplace credits40 NUSDWallet approval needed40 NUSD/);
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} });
  market.states[6] = "900";
  await market.settle();
  assert.equal(market.calls.length, 1);
  assert.equal(market.calls[0].call?.functionName, "makeOffer");
  assert.deepEqual(Array.from(market.calls[0].call?.args ?? []), [NFT, 3n, 80n * UNIT, market.state.timestamp + 72n * 3600n, 40n * UNIT]);
  assert.equal(market.calls[0].approval?.amount, 40n * UNIT);
  assert.equal(market.calls[0].call?.value, undefined);
});

test("buy reviews expected NUSD price and approves only the wallet shortfall", async () => {
  const market = harness();
  await market.click("Buy with NUSD");
  assert.equal(market.calls.length, 1);
  const transaction = market.calls[0];
  assert.equal(transaction.call?.address, MARKET);
  assert.equal(transaction.call?.functionName, "buy");
  assert.deepEqual(Array.from(transaction.call?.args ?? []), [1n, 100n * UNIT, 60n * UNIT]);
  assert.equal(transaction.approval?.token, NUSD);
  assert.equal(transaction.approval?.spender, MARKET);
  assert.equal(transaction.approval?.amount, 60n * UNIT);
  assert.equal(transaction.call?.value, undefined);
});

test("full credit purchase spends no wallet NUSD and insufficient funds never reach a signer", async () => {
  const credits = harness({ credit: 100n * UNIT, balance: 0n });
  await credits.click("Buy with NUSD");
  assert.equal(credits.calls[0].approval?.amount, 0n);
  assert.equal(credits.calls[0].call?.args?.[2], 0n);
  const underfunded = harness({ credit: 0n, balance: 99n * UNIT });
  await underfunded.click("Buy with NUSD");
  assert.equal(underfunded.calls.length, 0);
  assert.match(String(underfunded.states[1]), /Not enough NUSD/);
});

test("account, chain and connector changes during preflight block every signature", async () => {
  for (const changeKind of ["address", "chain", "connector"] as const) {
    const market = harness({ changeAt: "refresh", changeKind });
    await market.click("Buy with NUSD");
    assert.equal(market.calls.length, 0);
    assert.match(String(market.states[1]), /Wallet changed/);
  }
  for (const changeAt of ["quote", "approval"] as const) {
    const market = harness({ seller: true, changeAt });
    await market.click("Accept offer");
    assert.equal(market.calls.length, 0);
    assert.match(String(market.states[1]), /Wallet changed/);
  }
});

test("accept offer signs minimum seller proceeds and approves one NFT, never the entire collection", async () => {
  const market = harness({ seller: true });
  await market.click("Accept offer");
  assert.equal(market.calls.length, 1);
  const stages = market.calls[0].stages;
  assert.equal(stages?.length, 2);
  const approval = stages?.[0].call;
  const acceptance = stages?.[1].call;
  assert.ok(approval && typeof approval !== "function");
  assert.ok(acceptance && typeof acceptance !== "function");
  assert.equal(approval.address, NFT);
  assert.equal(approval.functionName, "approve");
  assert.deepEqual(Array.from(approval.args ?? []), [MARKET, 3n]);
  assert.equal(acceptance.functionName, "acceptOffer");
  assert.deepEqual(Array.from(acceptance.args ?? []), [2n, 946n * UNIT / 10n]);
  assert.equal(market.calls[0].approval, undefined);
});

test("paused marketplace disables trading but keeps NUSD withdrawal and refunds available", async () => {
  const market = harness({ paused: true });
  assert.equal(market.button("Buy with NUSD").props.disabled, true);
  await market.click("Withdraw");
  assert.equal(market.calls[0].call?.functionName, "withdrawNusd");
  assert.equal(market.calls[0].call?.args?.[0], BUYER);
  await market.click("Cancel and refund credits");
  assert.equal(market.calls[1].call?.functionName, "cancelOffer");
  assert.ok(market.calls.every((call) => !call.approval && !call.stages));
});

test("stale state and failed reads cannot proceed to approval or settlement", async () => {
  const stale = harness({ stale: true });
  await stale.click("Buy with NUSD");
  assert.equal(stale.calls.length, 0);
  assert.match(String(stale.states[1]), /stale/);
  const failed = harness({ error: true });
  assert.equal(failed.button("Buy with NUSD").props.disabled, true);
});

test("rapid repeated clicks cannot submit duplicate NUSD transactions", async () => {
  const market = harness();
  const buy = market.button("Buy with NUSD").props.onClick as () => void;
  buy(); buy();
  await market.settle();
  assert.equal(market.calls.length, 1);
  assert.equal(market.refreshes(), 2);
});

test("Gallery deep link preselects the NFT and listing uses NUSD without sending native value", async () => {
  const market = harness({ listingForm: true, seller: true });
  market.render();
  market.states[4] = "100";
  const form = find(market.render(), (element) => element.type === "form" && element.props.id === "sell-nusd");
  assert.ok(form);
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} });
  market.states[4] = "900";
  await market.settle();
  assert.equal(market.calls.length, 1);
  const approval = market.calls[0].stages?.[0].call;
  const listing = market.calls[0].stages?.[1].call;
  assert.ok(approval && typeof approval !== "function");
  assert.ok(listing && typeof listing !== "function");
  assert.equal(approval.functionName, "approve");
  assert.equal(listing.address, MARKET);
  assert.equal(listing.functionName, "list");
  assert.deepEqual(Array.from(listing.args ?? []), [NFT, 3n, 100n * UNIT]);
  assert.equal(listing.value, undefined);
  assert.equal(market.calls[0].approval, undefined);
});

test("listing preparation cannot continue after changing the connected wallet", async () => {
  const market = harness({ listingForm: true, seller: true, changeAt: "approval" });
  market.render();
  market.states[4] = "100";
  const form = find(market.render(), (element) => element.props.id === "sell-nusd");
  assert.ok(form);
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} });
  await market.settle();
  assert.equal(market.calls.length, 0);
  assert.match(String(market.states[1]), /Wallet changed/);
});

test("NUSD price edits preserve the reviewed amount without another NFT approval", async () => {
  const market = harness({ seller: true, listingForm: true, existingListing: true });
  market.render();
  market.states[4] = "0.000000000000000001";
  const form = find(market.render(), (element) => element.props.id === "sell-nusd")!;
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} });
  market.states[4] = "900";
  await market.settle();
  assert.equal(market.calls.length, 1);
  assert.equal(market.calls[0].call?.functionName, "updateListingPrice");
  assert.deepEqual(Array.from(market.calls[0].call?.args ?? []), [1n, 1n]);
  assert.equal(market.calls[0].stages, undefined);
  assert.equal(market.calls[0].approval, undefined);
  assert.equal(market.invalidations(), 1);
});

test("price edits and cancellation reject replaced wallets; cancellation works while paused", async () => {
  const changed = harness({ seller: true, listingForm: true, existingListing: true, changeAt: "listing" });
  changed.render();
  changed.states[4] = "100";
  const form = find(changed.render(), (element) => element.props.id === "sell-nusd")!;
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} });
  await changed.settle();
  assert.equal(changed.calls.length, 0);
  const paused = harness({ seller: true, listingForm: true, existingListing: true, paused: true });
  await paused.click("Cancel this NUSD listing");
  assert.equal(paused.calls[0].call?.functionName, "cancelListing");
  assert.deepEqual(Array.from(paused.calls[0].call?.args ?? []), [1n]);
  const replacement = harness({ seller: true, listingForm: true, existingListing: true, changeAt: "listing" });
  await replacement.click("Cancel this NUSD listing");
  assert.equal(replacement.calls.length, 0);
  const wrongChain = harness({ seller: true, chainId: 1 });
  assert.equal(wrongChain.button("Cancel listing").props.disabled, true);
});

test("global catalogue filtering happens before pagination and resets the page", () => {
  const market = harness();
  market.state.listings = Array.from({ length: 30 }, (_, index) => ({ id: BigInt(index + 1), collection: NFT, tokenId: BigInt(index + 1), price: BigInt(index + 1) * UNIT, seller: SELLER, active: true }));
  market.state.listingCount = 30n;
  market.render();
  market.states[2] = 1;
  assert.ok(find(market.render(), (element) => element.type === "article" && element.props["aria-label"] === "0xPixel #1"));
  const search = find(market.render(), (element) => element.type === "input" && element.props.type === "search")!;
  (search.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "#30" } });
  assert.equal(market.states[2], 0);
  assert.ok(find(market.render(), (element) => element.type === "article" && element.props["aria-label"] === "0xPixel #30"));
  assert.ok(!find(market.render(), (element) => element.type === "article" && element.props["aria-label"] === "0xPixel #1"));
});

test("rejected transactions never retry automatically and refresh includes history", async () => {
  const market = harness({ rejected: true });
  await market.click("Buy with NUSD");
  market.render(); market.render();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(market.calls.length, 1);
  assert.match(String(market.states[1]), /User rejected/);
  assert.equal(market.invalidations(), 0);
  const refresh = find(market.render(), (element) => element.type === "button" && element.props["aria-label"] === "Refresh marketplace")!;
  assert.ok(refresh);
  (refresh.props.onClick as () => void)();
  assert.equal(market.invalidations(), 1);
  assert.equal(market.render().props.lang, "en");
});
