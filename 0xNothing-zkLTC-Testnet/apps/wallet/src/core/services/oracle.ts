import type { Address, Hex } from "viem";
import { diaOracleAdapterAbi, nusdOracleAbi } from "../../abis";
import { CONTRACTS } from "../../config/contracts";
import { formatAmount } from "../lib/format";
import { applySlippage } from "../lib/swapMath";
import { publicClient } from "../rpc/client";
import { nusdOracleAddress } from "./nusdOracle";
import { writeCall } from "./tx";

/**
 * MINT NUSD. zkLTC in, NUSD out, settled at the DIA feed price with no AMM fee —
 * the same `quoteMint` + `mintAtOracle` pair the site's oracle panel uses.
 * Redeem is the mirror image and shares the screen.
 */
export interface OracleState {
  mintPaused: boolean;
  redeemPaused: boolean;
  ceilingNusd: bigint;
  totalSupplyNusd: bigint;
  /** How much NUSD may still be minted before the ceiling binds. */
  headroomNusd: bigint;
  collateralWei: bigint;
  priceWad: bigint;
  priceFresh: boolean;
}

export async function loadOracleState(): Promise<OracleState> {
  // The adapter comes off NUSD itself, so the price on screen is the price the
  // mint will settle at rather than a second opinion on the same feed.
  const adapter = await nusdOracleAddress();
  const calls = await publicClient.multicall({
    allowFailure: true,
    contracts: [
      { address: CONTRACTS.nusd, abi: nusdOracleAbi, functionName: "mintPaused" },
      { address: CONTRACTS.nusd, abi: nusdOracleAbi, functionName: "redeemPaused" },
      { address: CONTRACTS.nusd, abi: nusdOracleAbi, functionName: "supplyCeilingNusd" },
      { address: CONTRACTS.nusd, abi: nusdOracleAbi, functionName: "totalSupply" },
      { address: CONTRACTS.nusd, abi: nusdOracleAbi, functionName: "totalCollateralWei" },
      { address: adapter, abi: diaOracleAdapterAbi, functionName: "readPriceWad" },
      { address: adapter, abi: diaOracleAdapterAbi, functionName: "isFresh" },
    ] as const,
  });

  const value = <T>(index: number, fallback: T): T =>
    calls[index]?.status === "success" ? (calls[index]!.result as T) : fallback;

  const ceiling = value<bigint>(2, 0n);
  const supply = value<bigint>(3, 0n);
  const price = calls[5]?.status === "success"
    ? (calls[5]!.result as readonly [bigint, bigint, bigint])[0]
    : 0n;

  return {
    // Fail closed: a pause flag that could not be read is treated as paused.
    mintPaused: calls[0]?.status === "success" ? (calls[0]!.result as boolean) : true,
    redeemPaused: calls[1]?.status === "success" ? (calls[1]!.result as boolean) : true,
    ceilingNusd: ceiling,
    totalSupplyNusd: supply,
    headroomNusd: ceiling > supply ? ceiling - supply : 0n,
    collateralWei: value<bigint>(4, 0n),
    priceWad: price,
    priceFresh: calls[6]?.status === "success" ? (calls[6]!.result as boolean) : false,
  };
}

export async function quoteMint(collateralWei: bigint): Promise<bigint> {
  if (collateralWei <= 0n) return 0n;
  return publicClient.readContract({
    address: CONTRACTS.nusd,
    abi: nusdOracleAbi,
    functionName: "quoteMint",
    args: [collateralWei],
  });
}

export async function quoteRedeem(amountNusd: bigint): Promise<bigint> {
  if (amountNusd <= 0n) return 0n;
  return publicClient.readContract({
    address: CONTRACTS.nusd,
    abi: nusdOracleAbi,
    functionName: "quoteRedeem",
    args: [amountNusd],
  });
}

export async function mintNusd(params: {
  from: Address;
  collateralWei: bigint;
  quotedNusd: bigint;
  slippageBps: number;
}): Promise<Hex> {
  const minOut = applySlippage(params.quotedNusd, params.slippageBps);
  return writeCall({
    from: params.from,
    address: CONTRACTS.nusd,
    abi: nusdOracleAbi,
    functionName: "mintAtOracle",
    args: [minOut, params.from],
    value: params.collateralWei,
    kind: "mint-nusd",
    label: { key: "tx.mint", params: { amount: formatAmount(params.quotedNusd, 18, 2) } },
    detail: `${formatAmount(params.collateralWei, 18, 6)} zkLTC`,
  });
}

export async function redeemNusd(params: {
  from: Address;
  amountNusd: bigint;
  quotedCollateralWei: bigint;
  slippageBps: number;
}): Promise<Hex> {
  const minOut = applySlippage(params.quotedCollateralWei, params.slippageBps);
  return writeCall({
    from: params.from,
    address: CONTRACTS.nusd,
    abi: nusdOracleAbi,
    functionName: "redeemAtOracle",
    args: [params.amountNusd, minOut, params.from],
    kind: "redeem-nusd",
    label: { key: "tx.redeem", params: { amount: formatAmount(params.amountNusd, 18, 2) } },
    detail: `${formatAmount(params.quotedCollateralWei, 18, 6)} zkLTC`,
  });
}
