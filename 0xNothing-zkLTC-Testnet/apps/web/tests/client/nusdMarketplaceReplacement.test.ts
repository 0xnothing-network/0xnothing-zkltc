import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as marketplace from "../../lib/nusdMarketplace.ts";
import { formatUnits } from "viem";
import { getPixelImageUrl } from "../../lib/pixelImage.ts";
import { evaluateModule } from "../helpers/evaluateModule.ts";

type Element = { type: unknown; props: Record<string, unknown> };
const jsx = (type: unknown, props: Record<string, unknown>): Element => ({ type, props });
const NUSD = "0x677D63c78E77E0b1971530e1494Caee4Bd7d631e";
const NFT = "0xd83cb7aCEF921f98b6B983cBB712a583869Da9eB";
const DEPLOYED = "0x1111111111111111111111111111111111111111";
const generated = JSON.parse(readFileSync(new URL("../../lib/nusdMarketplace.generated.json", import.meta.url), "utf8"));
const confirmed = {
  ...generated,
  address: DEPLOYED,
  owner: DEPLOYED,
  feeRecipient: DEPLOYED,
  deploymentBlock: "1",
  deploymentHash: `0x${"ab".repeat(32)}`,
};

function configuration(override?: string, manifest = generated) {
  return evaluateModule<{ NUSD_MARKETPLACE_ADDRESS?: string }>(new URL("../../lib/nusdMarketplaceConfig.ts", import.meta.url), {
    "./publicConfig": { PIXEL_MARKET_NUSD_ADDRESS: NUSD }, "./nusdMarketplace": marketplace,
    "./nusdMarketplace.generated.json": { default: manifest },
  }, { process: { env: { NEXT_PUBLIC_PIXEL_NUSD_MARKETPLACE_ADDRESS: override } } });
}

function find(root: unknown, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(root)) return root.map((child) => find(child, predicate)).find(Boolean);
  if (!root || typeof root !== "object" || !("props" in root)) return undefined;
  const element = root as Element;
  return predicate(element) ? element : find(element.props.children, predicate);
}

test("pending generated config leaves trading off; a confirmed v2 record or override activates", () => {
  assert.equal(configuration().NUSD_MARKETPLACE_ADDRESS, undefined);
  assert.equal(configuration("").NUSD_MARKETPLACE_ADDRESS, undefined);
  assert.equal(configuration(undefined, confirmed).NUSD_MARKETPLACE_ADDRESS, DEPLOYED);
  assert.equal(configuration("", confirmed).NUSD_MARKETPLACE_ADDRESS, DEPLOYED);
  assert.equal(configuration(DEPLOYED).NUSD_MARKETPLACE_ADDRESS, DEPLOYED);
  assert.equal(configuration("invalid").NUSD_MARKETPLACE_ADDRESS, undefined);
  assert.equal(configuration("0x0000000000000000000000000000000000000000").NUSD_MARKETPLACE_ADDRESS, undefined);
  for (const manifest of [{ ...confirmed, chainId: 1 }, { ...confirmed, nusd: NFT }, { ...confirmed, implementation: "0x00" }, { ...confirmed, address: "" }]) {
    assert.equal(configuration(undefined, manifest).NUSD_MARKETPLACE_ADDRESS, undefined);
  }
  assert.equal(generated.address, "");
  assert.equal(generated.nusd.toLowerCase(), NUSD.toLowerCase());
  assert.equal(generated.implementation, marketplace.NUSD_MARKET_IMPLEMENTATION);
  assert.equal(generated.platformFeeBps, 40);
  assert.ok(!Object.keys(generated).some((key) => /private|secret/i.test(key)));
});

test("NFT deep links retain exact uint256 IDs and reject arrays, invalid addresses and oversized IDs", () => {
  assert.equal(marketplace.nusdNftSelection(NFT, "0003"), `${NFT.toLowerCase()}:3`);
  const maximum = (1n << 256n) - 1n;
  assert.equal(marketplace.nusdNftSelection(NFT, maximum.toString()), `${NFT.toLowerCase()}:${maximum}`);
  for (const [collection, tokenId] of [[NFT, (maximum + 1n).toString()], [NFT, "9".repeat(79)], [NFT, "-1"], [NFT, "1.5"], [NFT, "1e2"], [NFT, ["1", "2"]], [[NFT, NFT], "1"], ["invalid", "1"], [undefined, undefined]]) assert.equal(marketplace.nusdNftSelection(collection, tokenId), "");
});

test("the canonical marketplace renders NUSD and the former NUSD alias redirects without using the legacy ABI", async () => {
  const dashboard = () => null;
  const route = evaluateModule<{ default: (props: { searchParams: Promise<Record<string, unknown>> }) => Promise<Element>; metadata: { alternates: { canonical: string } } }>(new URL("../../app/0xpixel/marketplace/page.tsx", import.meta.url), {
    "react/jsx-runtime": { jsx, jsxs: jsx }, "@/features/pixel/components/NusdMarketplaceDashboard": { NusdMarketplaceDashboard: dashboard }, "@/lib/nusdMarketplace": marketplace,
  });
  const element = await route.default({ searchParams: Promise.resolve({ collection: NFT, tokenId: "3" }) });
  assert.equal(element.type, dashboard);
  assert.equal(element.props.initialTokenKey, `${NFT.toLowerCase()}:3`);
  assert.equal(route.metadata.alternates.canonical, "/0xpixel/marketplace");
  assert.equal((await route.default({ searchParams: Promise.resolve({ collection: [NFT, NFT], tokenId: "3" }) })).props.initialTokenKey, "");
  let destination;
  const alias = evaluateModule<{ default: () => void }>(new URL("../../app/0xpixel/marketplace/nusd/page.tsx", import.meta.url), { "next/navigation": { redirect: (url: string) => { destination = url; } } });
  alias.default();
  assert.equal(destination, "/0xpixel/marketplace");
});

test("Gallery has only NUSD selling and management, without native signer controls", () => {
  const { OwnedNftCard } = evaluateModule<{ OwnedNftCard: (props: Record<string, unknown>) => Element }>(new URL("../../features/pixel/components/OwnedNftCard.tsx", import.meta.url), {
    react: { memo: (fn: unknown) => fn }, "react/jsx-runtime": { jsx, jsxs: jsx }, "next/link": { default: "a" }, "next/image": { default: "img" },
    viem: { formatUnits }, "@/lib/contract": { getTokenExplorerUrl: () => "https://explorer.test/nft" }, "@/lib/pixelImage": { getPixelImageUrl },
  });
  const nft = { collection: NFT, tokenId: 3n, name: "NUSD artwork", imageUrl: "", listing: null };
  const plain = OwnedNftCard({ nft, isPaused: true, onChanged() {} });
  const link = find(plain, (element) => element.type === "a" && element.props.children === "SELL FOR NUSD");
  assert.ok(link);
  assert.equal(link.props.href, `/0xpixel/marketplace?collection=${NFT}&tokenId=3#sell-nusd`);
  assert.ok(!find(plain, (element) => "onPriceChange" in element.props));
  const listed = OwnedNftCard({ nft: { ...nft, listing: { listingId: 9n, price: 10n ** 18n } }, isPaused: false, onChanged() {} });
  assert.ok(find(listed, (element) => element.props.children === "MANAGE NUSD LISTING"));
  assert.ok(!find(listed, (element) => element.type === "button" || element.type === "form"));
  const source = readFileSync(new URL("../../features/pixel/components/OwnedNftCard.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /marketplaceAbi|formatEther|writeContract|legacyMarketplace/);
});

test("old marketplace bookmarks redirect to the only NUSD marketplace", async () => {
  const { default: config } = evaluateModule<{ default: { redirects: () => Promise<{ source: string; destination: string }[]> } }>(new URL("../../next.config.ts", import.meta.url), { "./lib/publicConfig": { LITVM_RPC_URL: "https://rpc.example" } }, { process: { env: {} }, __dirname: ".", URL });
  const redirect = (await config.redirects()).find((item) => item.source === "/0xpixel/marketplace/legacy");
  assert.equal(redirect?.destination, "/0xpixel/marketplace");
});
