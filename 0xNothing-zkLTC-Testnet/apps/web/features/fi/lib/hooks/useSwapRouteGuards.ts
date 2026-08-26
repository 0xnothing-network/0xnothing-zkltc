"use client";

import { useReadContract } from "wagmi";
import { deployment } from "@fi/config/deployment";
import { dexFactoryAbi } from "@fi/lib/abis/dex";
import { nusdOracleAbi } from "@fi/lib/abis/nusd";

/**
 * Fail-closed execution gates for the swap form: whichever pause switches govern
 * the selected route, plus the capacity the oracle side can actually settle.
 * A route is described by what it needs rather than by its shape, because an
 * oracle-bridged route settles through the oracle *and* the DEX, so both sets of
 * gates have to hold. Every field stays undefined until its read lands so the
 * form disables the swap while the state is unknown instead of assuming the
 * route is open.
 */
export function useSwapRouteGuards({
  needsDex,
  needsMint,
  needsRedeem,
}: {
  /** The route executes at least one pool hop through the DEX router. */
  needsDex: boolean;
  /** The route mints NUSD at the oracle. */
  needsMint: boolean;
  /** The route redeems NUSD at the oracle. */
  needsRedeem: boolean;
}) {
  const dexPauseState = useReadContract({
    address: deployment.contracts.dexFactory,
    abi: dexFactoryAbi,
    functionName: "swapsPaused",
    query: { enabled: Boolean(needsDex && deployment.contracts.dexFactory) },
  });
  const mintPauseState = useReadContract({
    address: deployment.contracts.nusd,
    abi: nusdOracleAbi,
    functionName: "mintPaused",
    query: { enabled: Boolean(needsMint && deployment.contracts.nusd) },
  });
  const redeemPauseState = useReadContract({
    address: deployment.contracts.nusd,
    abi: nusdOracleAbi,
    functionName: "redeemPaused",
    query: { enabled: Boolean(needsRedeem && deployment.contracts.nusd) },
  });
  const supplyCeilingState = useReadContract({
    address: deployment.contracts.nusd,
    abi: nusdOracleAbi,
    functionName: "supplyCeilingNusd",
    query: { enabled: Boolean(needsMint && deployment.contracts.nusd) },
  });
  const totalSupplyState = useReadContract({
    address: deployment.contracts.nusd,
    abi: nusdOracleAbi,
    functionName: "totalSupply",
    query: { enabled: Boolean(needsMint && deployment.contracts.nusd) },
  });
  const collateralReserveState = useReadContract({
    address: deployment.contracts.nusd,
    abi: nusdOracleAbi,
    functionName: "totalCollateralWei",
    query: { enabled: Boolean(needsRedeem && deployment.contracts.nusd) },
  });

  const pauseReads: readonly { data?: boolean; error: unknown }[] = [
    ...(needsDex ? [{ data: dexPauseState.data, error: dexPauseState.error }] : []),
    ...(needsMint ? [{ data: mintPauseState.data, error: mintPauseState.error }] : []),
    ...(needsRedeem ? [{ data: redeemPauseState.data, error: redeemPauseState.error }] : []),
  ];
  // Any applicable pause closes the route; "not paused" needs every switch to say so.
  const routePaused = pauseReads.some((read) => read.data === true)
    ? true
    : pauseReads.length > 0 && pauseReads.every((read) => read.data === false)
      ? false
      : undefined;
  const capacityStateReady = (!needsMint || (
    supplyCeilingState.data !== undefined && totalSupplyState.data !== undefined
    && !supplyCeilingState.error && !totalSupplyState.error
  )) && (!needsRedeem || (
    collateralReserveState.data !== undefined && !collateralReserveState.error
  ));
  const remainingMintCapacity = supplyCeilingState.data !== undefined && totalSupplyState.data !== undefined
    ? supplyCeilingState.data > totalSupplyState.data
      ? supplyCeilingState.data - totalSupplyState.data
      : 0n
    : undefined;

  return {
    mintCapacityUnavailable: Boolean(supplyCeilingState.error || totalSupplyState.error),
    redeemReserve: collateralReserveState.data,
    redeemReserveUnavailable: Boolean(collateralReserveState.error),
    remainingMintCapacity,
    routePaused,
    routeStateReady: pauseReads.length > 0
      && pauseReads.every((read) => read.data !== undefined && !read.error)
      && capacityStateReady,
  };
}
