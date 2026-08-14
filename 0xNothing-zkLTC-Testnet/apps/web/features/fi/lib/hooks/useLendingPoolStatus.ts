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

export type LendingPoolStatus =
  | "unconfigured"
  | "disabled"
  | "checking"
  | "rpc-error"
  | "verification-error"
  | "implementation-mismatch"
  | "rate-mismatch"
  | "collateral-mismatch"
  | "activation-mismatch"
  | "paused"
  | "ready";

const EXPECTED_IMPLEMENTATION_ID =
  "0x7a03229a63916cb50f31952711fc2ce4584e5105d94d54a1be15fda916848c70" as Hex;
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
  const enabled = configured && deployment.lendingRiskActionsEnabled;
  const query = useReadContracts({
    contracts: configured ? [
      { address: pool ?? zeroAddress, abi: lendingPoolAbi, functionName: "IMPLEMENTATION_ID" },
      { address: pool ?? zeroAddress, abi: lendingPoolAbi, functionName: "lenderRate" },
      { address: pool ?? zeroAddress, abi: lendingPoolAbi, functionName: "borrowRate" },
      { address: pool ?? zeroAddress, abi: lendingPoolAbi, functionName: "protocolRate" },
      { address: pool ?? zeroAddress, abi: lendingPoolAbi, functionName: "collateralConfigs", args: [nltc ?? zeroAddress] },
      { address: pool ?? zeroAddress, abi: lendingPoolAbi, functionName: "collateralConfigs", args: [nbtc ?? zeroAddress] },
      { address: pool ?? zeroAddress, abi: lendingPoolAbi, functionName: "collateralConfigs", args: [neth ?? zeroAddress] },
      { address: pool ?? zeroAddress, abi: lendingPoolAbi, functionName: "activated" },
      { address: pool ?? zeroAddress, abi: lendingPoolAbi, functionName: "bootstrapOpen" },
      { address: pool ?? zeroAddress, abi: lendingPoolAbi, functionName: "supplyPaused" },
      { address: pool ?? zeroAddress, abi: lendingPoolAbi, functionName: "borrowPaused" },
      { address: pool ?? zeroAddress, abi: lendingPoolAbi, functionName: "collateralWithdrawalPaused" },
    ] as const : [],
    query: { enabled },
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
  const activated = successfulResult(results?.[7]) as boolean | undefined;
  const bootstrapOpen = successfulResult(results?.[8]) as boolean | undefined;
  const supplyPaused = successfulResult(results?.[9]) as boolean | undefined;
  const borrowPaused = successfulResult(results?.[10]) as boolean | undefined;
  const collateralWithdrawalPaused = successfulResult(results?.[11]) as boolean | undefined;
  const ratesMatch = lenderRate === EXPECTED_LENDER_RATE
    && borrowRate === EXPECTED_BORROW_RATE
    && protocolRate === EXPECTED_PROTOCOL_RATE;
  const collateralConfigurationMatches = matchesRiskConfiguration(collateralConfigs.nLTC)
    && matchesRiskConfiguration(collateralConfigs.nBTC)
    && matchesRiskConfiguration(collateralConfigs.nETH);
  const hasFailedRead = Boolean(results?.some((result) => result.status !== "success"));

  let status: LendingPoolStatus;
  if (!configured) status = "unconfigured";
  else if (!deployment.lendingRiskActionsEnabled) status = "disabled";
  else if (query.isError) status = "rpc-error";
  else if (!results) status = "checking";
  else if (hasFailedRead) status = "verification-error";
  else if (implementationId !== EXPECTED_IMPLEMENTATION_ID) status = "implementation-mismatch";
  else if (!ratesMatch) status = "rate-mismatch";
  else if (!collateralConfigurationMatches) status = "collateral-mismatch";
  else if (activated !== true || bootstrapOpen !== false) status = "activation-mismatch";
  else if (supplyPaused || borrowPaused || collateralWithdrawalPaused) status = "paused";
  else status = "ready";

  const statusCopy: Record<LendingPoolStatus, { title: string; message: string; actionLabel: string }> = {
    unconfigured: {
      title: "Lending is not configured",
      message: "The testnet lending deployment is missing one or more contract addresses.",
      actionLabel: "Not deployed",
    },
    disabled: {
      title: "Lending activation pending",
      message: "New supply, collateral deposits, and borrowing stay disabled while the deployment is finalized. Exit actions remain available.",
      actionLabel: "Activation pending",
    },
    checking: {
      title: "Verifying lending pool",
      message: "Checking the implementation, fixed rates, and collateral limits on-chain.",
      actionLabel: "Verifying pool",
    },
    "rpc-error": {
      title: "Lending verification unavailable",
      message: "The RPC request failed, so risk-increasing actions remain disabled until verification succeeds.",
      actionLabel: "RPC unavailable",
    },
    "verification-error": {
      title: "Lending verification failed",
      message: "One or more required pool reads failed. Risk-increasing actions remain disabled.",
      actionLabel: "Verification failed",
    },
    "implementation-mismatch": {
      title: "Lending upgrade required",
      message: "The configured address does not expose the expected fixed-rate lending implementation.",
      actionLabel: "Upgrade required",
    },
    "rate-mismatch": {
      title: "Lending rate mismatch",
      message: "The on-chain lender, borrower, or protocol rate differs from the verified deployment.",
      actionLabel: "Rates unverified",
    },
    "collateral-mismatch": {
      title: "Lending risk limits mismatch",
      message: "One or more collateral assets do not match the required 80 / 85 / 90 risk configuration.",
      actionLabel: "Limits unverified",
    },
    "activation-mismatch": {
      title: "Lending activation incomplete",
      message: "The fixed-rate pool is still in bootstrap or has not completed its atomic activation.",
      actionLabel: "Activation pending",
    },
    paused: {
      title: "Lending risk actions paused",
      message: "A guardian pause is active. Verified collateral top-ups and exit actions that remain available on-chain can still be used.",
      actionLabel: "Guardian pause",
    },
    ready: {
      title: "Lending verified",
      message: "The fixed-rate pool and collateral limits match the active testnet deployment.",
      actionLabel: "Ready",
    },
  };
  const ready = status === "ready";
  const verified = status === "ready" || status === "paused";
  const checking = status === "checking";

  return {
    status,
    ...statusCopy[status],
    ready,
    verified,
    supplyReady: verified && supplyPaused === false,
    borrowReady: verified && borrowPaused === false,
    collateralDepositReady: verified,
    collateralWithdrawalReady: verified && collateralWithdrawalPaused === false,
    checking,
    configured,
    lenderRate: verified ? lenderRate : undefined,
    borrowRate: verified ? borrowRate : undefined,
    protocolRate: verified ? protocolRate : undefined,
    collateralConfigs,
    activated,
    bootstrapOpen,
    supplyPaused,
    borrowPaused,
    collateralWithdrawalPaused,
    refetch: query.refetch,
  };
}
