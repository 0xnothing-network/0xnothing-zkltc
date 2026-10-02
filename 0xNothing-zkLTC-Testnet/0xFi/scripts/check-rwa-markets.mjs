import { readFileSync } from "node:fs";
import { createPublicClient, erc20Abi, http, parseAbi } from "viem";
import { validateMarkets, readRwaState } from "../../shared/rwa/core.ts";
import { rwaMarketAbi, rwaOracleAbi } from "../../shared/rwa/abi.ts";

const manifest = JSON.parse(readFileSync(new URL("../../shared/rwa/markets.json", import.meta.url), "utf8"));
const markets = validateMarkets(manifest.markets);
if (markets.length === 0) {
  console.log("No RWA market configured. Trading remains disabled in both clients.");
} else {
  const index = process.argv.indexOf("--rpc-url");
  const rpc = index >= 0 ? process.argv[index + 1] : process.env.RWA_RPC_URL;
  if (!rpc) throw new Error("Provide --rpc-url or RWA_RPC_URL");
  const client = createPublicClient({ transport: http(rpc, { retryCount: 1, timeout: 15_000 }) });
  const chainId = await client.getChainId();
  const block = await client.getBlock();
  const adapterAbi = parseAbi([
    "function feed() view returns (address)", "function description() view returns (string)",
    "function minPriceWad() view returns (uint256)", "function maxPriceWad() view returns (uint256)",
  ]);
  const abi = [...rwaMarketAbi, ...rwaOracleAbi, ...erc20Abi, ...adapterAbi];
  const read = (address, functionName, args) => client.readContract({ address, abi, functionName, args, blockNumber: block.number });
  for (const market of markets) {
    if (market.chainId !== chainId || chainId !== 4441) throw new Error("RWA catalog/RPC chain mismatch");
    const state = await readRwaState(read, market);
    if (!state.price) throw new Error(`${market.name}: oracle checks failed`);
    const oracle = await read(market.market, "oracle");
    const sources = await Promise.all(["assetPrimary", "assetSecondary", "settlementPrimary", "settlementSecondary"]
      .map((name) => read(oracle, name)));
    const upstream = await Promise.all(sources.map((source) => read(source, "feed")));
    if (new Set(upstream.map((feed) => feed.toLowerCase())).size !== 4) {
      throw new Error(`${market.name}: adapters share upstream feeds`);
    }
    const descriptions = await Promise.all(upstream.map((feed) => read(feed, "description")));
    for (const source of sources) {
      const [min, max] = await Promise.all([read(source, "minPriceWad"), read(source, "maxPriceWad")]);
      if (min <= 0n || max <= min) throw new Error(`${market.name}: invalid source price bounds`);
    }
    console.log(JSON.stringify({ name: market.name, market: market.market, owner: state.owner, paused: state.paused,
      availableLiquidity: state.liquidity.toString(), feeReserve: state.fees.toString(),
      withdrawableFees: state.withdrawable.toString(), upstream, descriptions }, null, 2));
    if (!state.paused && (state.liquidity === 0n || state.inventory === 0n)) {
      throw new Error(`${market.name}: open market has no two-sided inventory`);
    }
  }
  console.log("RWA onchain checks passed. Source independence and issuer backing still require the documented operator review.");
}
