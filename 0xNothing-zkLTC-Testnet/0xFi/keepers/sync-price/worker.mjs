import {
  decideSyncPrice,
  DEFAULT_LEAD_SECONDS,
  parseBoundedInteger,
  resolveAdapterAddress,
} from "../../scripts/lib/sync-price-policy.mjs";

export const SELECTORS = {
  isFresh: "0x6268ceaa",
  anchorPriceWad: "0xf7c68acd",
  anchorUpdatedAt: "0x42aaa530",
  maxPriceAge: "0x1584410a",
  syncPrice: "0x3f438fbb",
};

export async function jsonRpc(rpcUrl, method, params, fetchImpl = fetch) {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`RPC ${method} failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || `RPC ${method} failed`);
  return payload.result;
}

function decodeUint(word) {
  if (typeof word !== "string" || !word.startsWith("0x")) throw new Error("Invalid ABI word");
  return BigInt(word);
}

export function planWorkerRun(snapshot) {
  return decideSyncPrice({
    canReadPrice: snapshot.fresh,
    anchorPriceWad: snapshot.anchorPriceWad,
    anchorUpdatedAt: snapshot.anchorUpdatedAt,
    maxPriceAge: snapshot.maxPriceAge,
    now: snapshot.now,
    leadSeconds: snapshot.leadSeconds,
  });
}

export async function readAdapterSnapshot(env, fetchImpl = fetch) {
  const rpcUrl = env.RPC_URL || env.LITEFORGE_RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL is required");
  const adapter = resolveAdapterAddress(env.SYNC_PRICE_ADAPTER || env.ADAPTER_ADDRESS);
  const expectedChainId = Number(env.CHAIN_ID || 4441);
  const chainId = Number(decodeUint(await jsonRpc(rpcUrl, "eth_chainId", [], fetchImpl)));
  if (chainId !== expectedChainId) {
    throw new Error(`Wrong chain: expected ${expectedChainId}, received ${chainId}`);
  }

  const [freshWord, anchorWord, updatedWord, ageWord, block] = await Promise.all([
    jsonRpc(rpcUrl, "eth_call", [{ to: adapter, data: SELECTORS.isFresh }, "latest"], fetchImpl),
    jsonRpc(rpcUrl, "eth_call", [{ to: adapter, data: SELECTORS.anchorPriceWad }, "latest"], fetchImpl),
    jsonRpc(rpcUrl, "eth_call", [{ to: adapter, data: SELECTORS.anchorUpdatedAt }, "latest"], fetchImpl),
    jsonRpc(rpcUrl, "eth_call", [{ to: adapter, data: SELECTORS.maxPriceAge }, "latest"], fetchImpl),
    jsonRpc(rpcUrl, "eth_getBlockByNumber", ["latest", false], fetchImpl),
  ]);

  return {
    chainId,
    adapter,
    fresh: decodeUint(freshWord) !== 0n,
    anchorPriceWad: decodeUint(anchorWord),
    anchorUpdatedAt: decodeUint(updatedWord),
    maxPriceAge: decodeUint(ageWord),
    now: Number(decodeUint(block.timestamp)),
    leadSeconds: parseBoundedInteger(env.SYNC_PRICE_LEAD_SECONDS, {
      name: "SYNC_PRICE_LEAD_SECONDS",
      defaultValue: DEFAULT_LEAD_SECONDS,
      min: 0,
      max: 3_600,
    }),
  };
}

export async function runWorker(env, { fetchImpl = fetch, sendSyncPrice } = {}) {
  const snapshot = await readAdapterSnapshot(env, fetchImpl);
  const decision = planWorkerRun(snapshot);
  const result = {
    adapter: snapshot.adapter,
    chainId: snapshot.chainId,
    ...decision,
    synced: false,
  };
  if (decision.action !== "sync" || env.DRY_RUN === "1" || !sendSyncPrice) return result;
  const hash = await sendSyncPrice({ adapter: snapshot.adapter, env });
  return { ...result, synced: true, transactionHash: hash };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runWorker(env));
  },
  async fetch(_request, env) {
    const result = await runWorker({ ...env, DRY_RUN: "1" });
    return Response.json(result);
  },
};
