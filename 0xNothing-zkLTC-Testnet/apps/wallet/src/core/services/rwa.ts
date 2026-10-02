import { erc20Abi, type Abi, type Address } from "viem";
import { isLitvmNetwork, networkIdentity } from "../../config/networks";
import { isUnlocked, readAccounts } from "../keyring/vault";
import { activeNetwork, publicClient } from "../rpc/client";
import { ensureAllowance, writeCall } from "./tx";
import { rwaMarketAbi, rwaOracleAbi } from "../../../../../shared/rwa/abi";
import { rwaMarkets } from "../../../../../shared/rwa/markets";
import { decodeQuote, readRwaState, type RwaMarketConfig } from "../../../../../shared/rwa/core";

export { rwaMarkets };
const readAbi: Abi = [...rwaMarketAbi, ...rwaOracleAbi, ...erc20Abi];

function contextFor(config: RwaMarketConfig) {
  const context = { network: activeNetwork, client: publicClient };
  if (!isLitvmNetwork(context.network) || context.network.chainId !== config.chainId
    || !rwaMarkets.some((market) => market === config)) throw new Error("RWA market is not configured on this network");
  return context;
}

export async function loadRwaState(config: RwaMarketConfig, account: Address) {
  const { client } = contextFor(config);
  const block = await client.getBlock();
  return readRwaState((contract, functionName, args) => client.readContract({
    address: contract, abi: readAbi, functionName, args, blockNumber: block.number,
  }), config, account);
}

export async function quoteRwa(config: RwaMarketConfig, buy: boolean, amount: bigint) {
  const { client } = contextFor(config);
  const block = await client.getBlock();
  const values = decodeQuote(await client.readContract({ address: config.market, abi: rwaMarketAbi,
    functionName: "quote", args: [buy, amount], blockNumber: block.number }));
  return { values, deadline: block.timestamp + 300n };
}

export async function tradeRwa(params: { config: RwaMarketConfig; from: Address; buy: boolean;
  amount: bigint; limit: bigint; deadline: bigint }) {
  const { config, from, buy, amount, limit, deadline } = params;
  const context = contextFor(config);
  async function assertSession() {
    if (!(await isUnlocked())) throw new Error("Wallet locked. Review the RWA trade again after unlocking.");
    const accounts = await readAccounts();
    if (networkIdentity(activeNetwork) !== networkIdentity(context.network)) throw new Error("Network changed. Review the RWA trade again.");
    if ((accounts.active ?? accounts.accounts[0]?.address)?.toLowerCase() !== from.toLowerCase()) {
      throw new Error("Account changed. Review the RWA trade again.");
    }
  }
  const guardedContext = { ...context, assertReady: assertSession };
  await assertSession();
  if (amount <= 0n || limit <= 0n) throw new Error("Invalid RWA trade");
  const block = await context.client.getBlock();
  // Verify token identities on the same client before granting any allowance.
  await readRwaState((contract, functionName, args) => context.client.readContract({
    address: contract, abi: readAbi, functionName, args, blockNumber: block.number,
  }), config, from);
  if (block.timestamp > deadline) throw new Error("RWA quote expired. Request a new quote.");
  // Read an executable quote before approval, so paused/stale/illiquid markets cannot prompt approval.
  const quote = decodeQuote(await context.client.readContract({ address: config.market, abi: rwaMarketAbi,
    functionName: "quote", args: [buy, amount] }));
  if (buy ? quote[2] > limit : quote[2] < limit) throw new Error("RWA price moved outside the reviewed limit");
  await assertSession();
  await ensureAllowance({ from, token: buy ? config.settlement : config.asset, spender: config.market,
    amount: buy ? limit : amount, symbol: buy ? config.settlementSymbol : config.assetSymbol }, guardedContext);
  await assertSession();
  return writeCall({ from, address: config.market, abi: rwaMarketAbi,
    functionName: buy ? "buy" : "sell", args: [amount, limit, deadline], kind: "swap",
    label: { key: buy ? "rwa.txBuy" : "rwa.txSell", params: { symbol: config.assetSymbol } },
  }, guardedContext);
}
