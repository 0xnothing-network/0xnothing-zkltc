"use client";

import { useReadContract } from "wagmi";
import { deployment } from "@fi/config/deployment";
import { dexFactoryAbi } from "@fi/lib/abis/dex";
import { nusdOracleAbi } from "@fi/lib/abis/nusd";

/**
 * Fail-closed execution gates for the swap form: whichever pause switch governs
 * the selected route, plus the capacity the oracle side can actually settle.
 * Every field stays undefined until its read lands so the form disables the
 * swap while the state is unknown instead of assuming the route is open.
 */
export function useSwapRouteGuards({
  isMintRoute,
  isOracleRoute,
}: {
  isMintRoute: boolean;
  isOracleRoute: boolean;
}) {
  const dexPauseState = useReadContract({
    address: deployment.contracts.dexFactory,
    abi: dexFactoryAbi,
    functionName: "swapsPaused",
    query: { enabled: Boolean(!isOracleRoute && deployment.contracts.dexFactory) },
  });
  const mintPauseState = useReadContract({
    address: deployment.contracts.nusd,
    abi: nusdOracleAbi,
    functionName: "mintPaused",
    query: { enabled: Boolean(isMintRoute && deployment.contracts.nusd) },
  });
  const redeemPauseState = useReadContract({
    address: deployment.contracts.nusd,
    abi: nusdOracleAbi,
    functionName: "redeemPaused",
    query: { enabled: Boolean(isOracleRoute && !isMintRoute && deployment.contracts.nusd) },
  });
  const supplyCeilingState = useReadContract({
    address: deployment.contracts.nusd,
    abi: nusdOracleAbi,
    functionName: "supplyCeilingNusd",
    query: { enabled: Boolean(isMintRoute && deployment.contracts.nusd) },
  });
  const totalSupplyState = useReadContract({
    address: deployment.contracts.nusd,
    abi: nusdOracleAbi,
    functionName: "totalSupply",
    query: { enabled: Boolean(isMintRoute && deployment.contracts.nusd) },
  });
  const collateralReserveState = useReadContract({
    address: deployment.contracts.nusd,
    abi: nusdOracleAbi,
    functionName: "totalCollateralWei",
    query: { enabled: Boolean(isOracleRoute && !isMintRoute && deployment.contracts.nusd) },
  });

  const pauseState = isOracleRoute
    ? isMintRoute ? mintPauseState : redeemPauseState
    : dexPauseState;
  const capacityStateReady = !isOracleRoute || (isMintRoute
    ? supplyCeilingState.data !== undefined && totalSupplyState.data !== undefined && !supplyCeilingState.error && !totalSupplyState.error
    : collateralReserveState.data !== undefined && !collateralReserveState.error);
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
    routePaused: pauseState.data,
    routeStateReady: pauseState.data !== undefined && !pauseState.error && capacityStateReady,
  };
}
