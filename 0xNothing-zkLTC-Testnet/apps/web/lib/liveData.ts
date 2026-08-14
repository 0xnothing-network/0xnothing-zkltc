import type { QueryClient, QueryKey } from "@tanstack/react-query";

export const BLOCK_SYNC_MS = 10_000;
export const LIVE_MS = 5_000;
export const STEADY_LIVE_MS = 10_000;
export const FI_LIVE_MS = 15_000;

const MUTABLE_CONTRACT_READS = new Set([
  "accountRisk",
  "accruedProtocolFeesNusd",
  "activated",
  "admin",
  "allocationsPaused",
  "allowance",
  "availableLiquidity",
  "balanceOf",
  "bootstrapOpen",
  "borrowPaused",
  "borrowRate",
  "collateralBalance",
  "collateralConfigs",
  "collateralWithdrawalPaused",
  "createFee",
  "createdTokenByContentHash",
  "creationReservations",
  "curveProgressBps",
  "debtBalance",
  "depositsPaused",
  "earned",
  "enabled",
  "freeReserveNusd",
  "gaugeForPair",
  "getApproved",
  "getAmountsOut",
  "getListingByToken",
  "getReserves",
  "graduateReady",
  "graduationsPaused",
  "isAdapterAllowed",
  "isApprovedForAll",
  "isFresh",
  "latestRoundData",
  "listings",
  "markets",
  "maxBorrow",
  "maxMintableSynthetic",
  "maxUserCollateralWithdrawable",
  "maxWithdraw",
  "maxWithdrawCollateral",
  "mintPaused",
  "oracle",
  "ownerOf",
  "paused",
  "pausedRewardDuration",
  "periodFinish",
  "position",
  "positions",
  "quoteBuy",
  "quoteDepositAndMint",
  "quoteMint",
  "quoteMintFee",
  "quoteRedeem",
  "quoteSell",
  "readPriceWad",
  "redeemPaused",
  "reserveMarket",
  "reserveValueNusd",
  "rewardRate",
  "safetyReserve",
  "sponsorshipActive",
  "spotPriceNusdWad",
  "status",
  "supplyBalance",
  "supplyCeilingNusd",
  "supplyPaused",
  "swapsPaused",
  "totalBorrowed",
  "totalCollateralWei",
  "totalFunded",
  "totalPaid",
  "totalReserveNusd",
  "totalSupplied",
  "totalSupply",
  "withdrawPaused",
]);

function readFunctionName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const functionName = (value as { functionName?: unknown }).functionName;
  return typeof functionName === "string" ? functionName : undefined;
}

export function isBlockSyncedQueryKey(queryKey: QueryKey): boolean {
  const prefix = queryKey[0];
  if (prefix === "balance") return true;
  if (prefix === "readContract") {
    const functionName = readFunctionName(queryKey[1]);
    return Boolean(functionName && MUTABLE_CONTRACT_READS.has(functionName));
  }
  if (prefix === "readContracts") {
    const contracts = (queryKey[1] as { contracts?: unknown } | undefined)?.contracts;
    return Array.isArray(contracts) && contracts.some((contract) => {
      const functionName = readFunctionName(contract);
      return Boolean(functionName && MUTABLE_CONTRACT_READS.has(functionName));
    });
  }
  return false;
}

export async function invalidateAfterPumpTrade(queryClient: QueryClient, token: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["pump-market", token] }),
    queryClient.invalidateQueries({ queryKey: ["pump-trades", token] }),
    queryClient.invalidateQueries({ queryKey: ["pump-candles", token] }),
    queryClient.invalidateQueries({ queryKey: ["pump-holders", token] }),
    queryClient.invalidateQueries({ queryKey: ["pump-markets"] }),
    queryClient.invalidateQueries({ queryKey: ["pump-stats"] }),
    queryClient.invalidateQueries({
      predicate: (query) => {
        const prefix = query.queryKey[0];
        return typeof prefix === "string" && prefix.startsWith("pump-portfolio-");
      },
    }),
  ]);
}
