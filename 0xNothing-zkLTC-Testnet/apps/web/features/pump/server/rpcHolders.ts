import "server-only";

import { getAddress, parseAbiItem, type Address } from "viem";
import { publicClient } from "@/lib/contract";
import {
  PUMP_FACTORY_ADDRESS,
  PUMP_START_BLOCK,
  ZERO_ADDRESS,
} from "@/features/pump/config";
import { pumpTokenAbi, zeroXPumpAbi } from "@/features/pump/abis";
import type { PumpHoldersResponse } from "@/features/pump/types";
import {
  MAX_RPC_HOLDER_CANDIDATES,
  RPC_HOLDER_LOG_CONCURRENCY,
  RPC_LOG_BLOCK_CHUNK,
} from "./constants";
import { mergeCreatorHolder } from "./holders";
import type { RpcMarketState } from "./rpcMarkets";

/**
 * Holder reconstruction without an index: collect every address that ever
 * touched the token from its Transfer logs, then read the live balances. The
 * candidate cap and the balance retry are reported back as warnings so the UI
 * can say the list is partial instead of showing it as authoritative.
 */

const TOKEN_TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from,address indexed to,uint256 value)",
);

export async function getRpcHolders(token: Address, limit: number): Promise<PumpHoldersResponse> {
  const state = await publicClient.multicall({
    allowFailure: true,
    contracts: [
      { address: PUMP_FACTORY_ADDRESS, abi: zeroXPumpAbi, functionName: "markets", args: [token] },
      { address: token, abi: pumpTokenAbi, functionName: "totalSupply" },
      { address: token, abi: pumpTokenAbi, functionName: "balanceOf", args: [PUMP_FACTORY_ADDRESS] },
    ],
  });
  if (state[0].status !== "success") throw new Error("Holder market is unavailable");

  const market = state[0].result as RpcMarketState;
  if (!market[0] || market[0] === ZERO_ADDRESS) throw new Error("Holder market was not found");
  const creator = getAddress(market[0]);
  const totalSupply = state[1].status === "success"
    ? state[1].result
    : await publicClient.readContract({
        address: token,
        abi: pumpTokenAbi,
        functionName: "totalSupply",
      });
  const curveBalance = state[2].status === "success"
    ? state[2].result
    : await publicClient.readContract({
        address: token,
        abi: pumpTokenAbi,
        functionName: "balanceOf",
        args: [PUMP_FACTORY_ADDRESS],
      });
  const latestBlock = await publicClient.getBlockNumber();
  const configuredStartBlock = PUMP_START_BLOCK > 0n;
  const fromBlock = configuredStartBlock
    ? PUMP_START_BLOCK
    : latestBlock > 500_000n
      ? latestBlock - 500_000n
      : 0n;
  const candidates = new Map<string, Address>();
  let candidatesTruncated = false;
  const addCandidate = (account: Address | undefined) => {
    if (!account || account === ZERO_ADDRESS || account.toLowerCase() === PUMP_FACTORY_ADDRESS.toLowerCase()) return;
    const normalized = getAddress(account);
    const key = normalized.toLowerCase();
    if (candidates.has(key)) return;
    if (candidates.size >= MAX_RPC_HOLDER_CANDIDATES) {
      candidatesTruncated = true;
      return;
    }
    candidates.set(key, normalized);
  };
  addCandidate(creator);

  const logRanges: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  for (let chunkFrom = fromBlock; chunkFrom <= latestBlock; chunkFrom += RPC_LOG_BLOCK_CHUNK) {
    const chunkTo = chunkFrom + RPC_LOG_BLOCK_CHUNK - 1n > latestBlock
      ? latestBlock
      : chunkFrom + RPC_LOG_BLOCK_CHUNK - 1n;
    logRanges.push({ fromBlock: chunkFrom, toBlock: chunkTo });
  }
  for (let start = 0; start < logRanges.length; start += RPC_HOLDER_LOG_CONCURRENCY) {
    const pages = await Promise.all(
      logRanges.slice(start, start + RPC_HOLDER_LOG_CONCURRENCY).map((range) =>
        publicClient.getLogs({
          address: token,
          event: TOKEN_TRANSFER_EVENT,
          fromBlock: range.fromBlock,
          toBlock: range.toBlock,
        })),
    );
    for (const logs of pages) {
      for (const log of logs) {
        if ((log.args.value ?? 0n) === 0n) continue;
        addCandidate(log.args.from);
        addCandidate(log.args.to);
      }
    }
  }

  const addresses = [...candidates.values()];
  const balances = new Map<string, bigint>();
  let failedReads = 0;
  for (let start = 0; start < addresses.length; start += 200) {
    const page = addresses.slice(start, start + 200);
    let results = await publicClient.multicall({
      allowFailure: true,
      contracts: page.map((account) => ({
        address: token,
        abi: pumpTokenAbi,
        functionName: "balanceOf" as const,
        args: [account] as const,
      })),
    });
    const retryAccounts = page.filter((_, index) => results[index].status !== "success");
    if (retryAccounts.length) {
      const retries = await publicClient.multicall({
        allowFailure: true,
        contracts: retryAccounts.map((account) => ({
          address: token,
          abi: pumpTokenAbi,
          functionName: "balanceOf" as const,
          args: [account] as const,
        })),
      });
      let retryIndex = 0;
      results = results.map((result) =>
        result.status === "success" ? result : retries[retryIndex++]);
    }
    results.forEach((result, index) => {
      if (result.status === "success") {
        balances.set(page[index].toLowerCase(), result.result as bigint);
      } else {
        failedReads += 1;
      }
    });
  }

  const allHolders = addresses
    .map((account) => ({
      account,
      balance: balances.get(account.toLowerCase()) ?? 0n,
      isCreator: account.toLowerCase() === creator.toLowerCase(),
    }))
    .filter((holder) => holder.balance > 0n)
    .sort((left, right) => {
      if (left.balance !== right.balance) return left.balance > right.balance ? -1 : 1;
      return left.account.toLowerCase().localeCompare(right.account.toLowerCase());
    });
  const creatorBalance = balances.get(creator.toLowerCase()) ?? 0n;
  const holders = mergeCreatorHolder(
    allHolders.slice(0, limit).map((holder) => ({
      account: holder.account,
      balance: holder.balance.toString(),
      isCreator: holder.isCreator,
    })),
    creator,
    creatorBalance.toString(),
  );
  const warnings = [
    !configuredStartBlock ? "Holder scan is limited because the pump start block is not configured." : "",
    candidatesTruncated ? `Holder scan reached the ${MAX_RPC_HOLDER_CANDIDATES.toLocaleString("en-US")} address safety limit.` : "",
    failedReads ? `${failedReads} holder balance${failedReads === 1 ? "" : "s"} could not be verified.` : "",
  ].filter(Boolean);

  return {
    holders,
    creator,
    totalSupply: totalSupply.toString(),
    curveBalance: curveBalance.toString(),
    holderCount: allHolders.length,
    source: "rpc",
    configured: true,
    warning: warnings.length ? warnings.join(" ") : undefined,
  };
}
