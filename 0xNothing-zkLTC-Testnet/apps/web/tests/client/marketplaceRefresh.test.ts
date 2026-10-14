import assert from "node:assert/strict";
import test from "node:test";
import { formatUnits } from "viem";
import { getPixelImageUrl } from "../../lib/pixelImage.ts";
import { evaluateModule } from "../helpers/evaluateModule.ts";

type Element = { type: unknown; props: Record<string, unknown> };
const jsx = (type: unknown, props: Record<string, unknown>): Element => ({ type, props });
function find(root: unknown, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(root)) return root.map((item) => find(item, predicate)).find(Boolean);
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
const NFT = "0x0000000000000000000000000000000000000033";
const event = { id: "tx:1", type: "BOUGHT", collection: NFT, tokenId: "3", actor: NFT, price: "1000000000000000001", timestamp: "1700000000", transactionHash: "0xtx" };
type QueryOptions = {
  queryKey: string[];
  enabled: boolean;
  queryFn: (options: { pageParam: string; signal: AbortSignal }) => Promise<unknown>;
  getNextPageParam: (page: { nextCursor: string | null }) => unknown;
  refetchInterval: (query: { state: { data?: { pages: unknown[] } } }) => number | false;
};
function harness(options: { configured?: boolean; empty?: boolean; error?: boolean; loading?: boolean; duplicate?: boolean } = {}) {
  let filter = "ALL", refetches = 0, resets = 0, more = 0;
  let release: () => void = () => {};
  let queryOptions: QueryOptions;
  let request: { url: string; signal: AbortSignal } | undefined;
  const state = {
    data: options.loading ? undefined : { pages: [{ events: options.empty ? [] : [event], nextCursor: "100:3" }, ...(options.duplicate ? [{ events: [event], nextCursor: null }] : [])] },
    isError: Boolean(options.error), isPending: Boolean(options.loading), isFetching: false, isFetchingNextPage: false, hasNextPage: true,
    refetch: async () => { refetches += 1; },
    fetchNextPage: () => { more += 1; return new Promise<void>((resolve) => { release = resolve; }); },
  };
  const { NusdMarketplaceActivity } = evaluateModule<{ NusdMarketplaceActivity: () => Element }>(new URL("../../features/pixel/components/NusdMarketplaceActivity.tsx", import.meta.url), {
    "react/jsx-runtime": { jsx, jsxs: jsx }, "next/image": { default: "img" },
    react: { useState: () => [filter, (next: string) => { filter = next; }], useRef: () => lock },
    "@tanstack/react-query": { useInfiniteQuery: (query: QueryOptions) => { queryOptions = query; return state; }, useQueryClient: () => ({ resetQueries: async () => { resets += 1; } }) },
    "@phosphor-icons/react": { ArrowUpRight: "svg", ArrowsClockwise: "svg" }, viem: { formatUnits },
    "@/lib/http": { fetchJson: async (url: string, { signal }: { signal: AbortSignal }) => { request = { url, signal }; return {}; } },
    "@/lib/contract": { getMarketplaceTxUrl: () => "/tx", getTokenExplorerUrl: () => "/nft", shortenAddress: String }, "@/lib/pixelImage": { getPixelImageUrl },
    "@/lib/nusdMarketplaceConfig": { NUSD_MARKETPLACE_ADDRESS: options.configured === false ? undefined : NFT }, "./NusdMarketplaceDashboard.module.css": { default: {} },
  }, { encodeURIComponent });
  const lock = { current: false };
  function button(label: string) {
    const value = find(NusdMarketplaceActivity(), (element) => element.type === "button" && (content(element.props.children) === label || element.props["aria-label"] === label));
    assert.ok(value, label);
    return value;
  }
  return { render: NusdMarketplaceActivity, button, state, query: () => queryOptions!, request: () => request, counts: () => ({ more, resets, refetches }), release: () => release() };
}

test("NUSD activity filters isolate queries and pass cancellation signals with exact cursors", async () => {
  const activity = harness();
  activity.render();
  const controller = new AbortController();
  await activity.query().queryFn({ pageParam: "100:3", signal: controller.signal });
  assert.equal(activity.request()?.url, "/api/marketplace/activity?type=ALL&limit=24&cursor=100%3A3");
  assert.equal(activity.request()?.signal, controller.signal);
  (activity.button("Sold").props.onClick as () => void)();
  activity.render();
  assert.equal(activity.query().queryKey[2], "BOUGHT");
  assert.equal(activity.query().getNextPageParam({ nextCursor: "99:2" }), "99:2");
  assert.equal(activity.query().getNextPageParam({ nextCursor: null }), undefined);
});

test("NUSD activity load-more is single-flight and latest refresh does not refetch all old pages", async () => {
  const activity = harness({ duplicate: true });
  const tree = activity.render();
  assert.equal((content(tree).match(/1.000000000000000001 NUSD/g) ?? []).length, 1);
  const click = activity.button("Load more activity").props.onClick as () => void;
  click(); click();
  assert.equal(activity.counts().more, 1);
  activity.release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  click();
  assert.equal(activity.counts().more, 2);
  activity.release();
  (activity.button("Back to latest").props.onClick as () => void)();
  (activity.button("Refresh activity").props.onClick as () => void)();
  assert.equal(activity.counts().resets, 1);
  assert.equal(activity.counts().refetches, 1);
  assert.equal(activity.query().refetchInterval({ state: { data: { pages: [{}, {}] } } }), false);
  assert.equal(activity.query().refetchInterval({ state: { data: { pages: [{}] } } }), 10_000);
});

test("activity loading, sparse pages, errors and missing configuration stay explicit in English", () => {
  assert.match(content(harness({ loading: true }).render()), /Loading on-chain activity/);
  const sparse = harness({ empty: true });
  assert.match(content(sparse.render()), /since this market launched/);
  assert.ok(sparse.button("Load more activity"));
  const failed = harness({ error: true });
  assert.ok(failed.button("Retry"));
  assert.ok(find(failed.render(), (element) => element.props.role === "alert"));
  const unconfigured = harness({ configured: false });
  unconfigured.render();
  assert.equal(unconfigured.query().enabled, false);
});
