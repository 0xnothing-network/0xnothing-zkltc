"use client";

import { zeroAddress, type Address, type Hex } from "viem";
import { useReadContracts } from "wagmi";
import { deployment } from "@fi/config/deployment";
import { lendingPoolAbi } from "@fi/lib/abis/lending";

export type LendingCollateralSymbol = "nLTC" | "nBTC" | "nETH";
export type LendingCollateralConfig = readonly [
  Address,
  bigint,
  number,
  number,
  number,
  number,
  boolean,
  number,
];

const EXPECTED_IMPLEMENTATION_ID =
  "0xba492415271863e1048d1005097c251259a852b2971faf0c159c23c13e562002" as Hex;
const EXPECTED_LENDER_RATE = 40_000_000_000_000_000n;
const EXPECTED_BORROW_RATE = 45_000_000_000_000_000n;
const EXPECTED_PROTOCOL_RATE = 5_000_000_000_000_000n;

function successfulResult(result: { status: string; result?: unknown } | undefined): unknown {
  return result?.status === "success" ? result.result : undefined;
}

function matchesRiskConfiguration(value: LendingCollateralConfig | undefined): boolean {
  return Boolean(
    value
      && value[0] !== zeroAddress
      && value[1] > 0n
      && value[2] === 8000
      && value[3] === 9000
      && value[4] === 500
      && value[5] === 18
      && value[6]
      && value[7] === 8500,
  );
}

export function lendingCollateralAddress(symbol: LendingCollateralSymbol): Address | undefined {
  if (symbol === "nLTC") return deployment.contracts.wzkltc;
  if (symbol === "nBTC") return deployment.contracts.nbtc;
  return deployment.contracts.neth;
}

export function useLendingPoolStatus() {
  const pool = deployment.contracts.lendingPool;
  const nltc = deployment.contracts.wzkltc;
  const nbtc = deployment.contracts.nbtc;
  const neth = deployment.contracts.neth;
  const configured = Boolean(pool && nltc && nbtc && neth);
  const query = useReadContracts({
    contracts: configured ? [
      { address: pool ?? zeroAddress, abi: lendingPoolAbi, functionName: "IMPLEMENTATION_ID" },
      { address: pool ?? zeroAddress, abi: lendingPoolAbi, functionName: "lenderRate" },
      { address: pool ?? zeroAddress, abi: lendingPoolAbi, functionName: "borrowRate" },
      { address: pool ?? zeroAddress, abi: lendingPoolAbi, functionName: "protocolRate" },
      { address: pool ?? zeroAddress, abi: lendingPoolAbi, functionName: "collateralConfigs", args: [nltc ?? zeroAddress] },
      { address: pool ?? zeroAddress, abi: lendingPoolAbi, functionName: "collateralConfigs", args: [nbtc ?? zeroAddress] },
      { address: pool ?? zeroAddress, abi: lendingPoolAbi, functionName: "collateralConfigs", args: [neth ?? zeroAddress] },
    ] as const : [],
    query: { enabled: configured, refetchInterval: 30_000 },
  });
  const results = query.data as readonly { status: string; result?: unknown }[] | undefined;
  const implementationId = successfulResult(results?.[0]) as Hex | undefined;
  const lenderRate = successfulResult(results?.[1]) as bigint | undefined;
  const borrowRate = successfulResult(results?.[2]) as bigint | undefined;
  const protocolRate = successfulResult(results?.[3]) as bigint | undefined;
  const collateralConfigs: Record<LendingCollateralSymbol, LendingCollateralConfig | undefined> = {
    nLTC: successfulResult(results?.[4]) as LendingCollateralConfig | undefined,
    nBTC: successfulResult(results?.[5]) as LendingCollateralConfig | undefined,
    nETH: successfulResult(results?.[6]) as LendingCollateralConfig | undefined,
  };
  const ready = configured
    && implementationId === EXPECTED_IMPLEMENTATION_ID
    && lenderRate === EXPECTED_LENDER_RATE
    && borrowRate === EXPECTED_BORROW_RATE
    && protocolRate === EXPECTED_PROTOCOL_RATE
    && matchesRiskConfiguration(collateralConfigs.nLTC)
    && matchesRiskConfiguration(collateralConfigs.nBTC)
    && matchesRiskConfiguration(collateralConfigs.nETH);
  const checking = configured && !results && (query.isPending || query.isFetching);

  return {
    ready,
    checking,
    configured,
    lenderRate: ready ? lenderRate : undefined,
    borrowRate: ready ? borrowRate : undefined,
    protocolRate: ready ? protocolRate : undefined,
    collateralConfigs,
    refetch: query.refetch,
  };
}
