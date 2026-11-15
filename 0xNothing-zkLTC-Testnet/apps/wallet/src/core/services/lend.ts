import type { Address, Hex } from "viem";
import { lendingPoolAbi } from "../../abis";
import { CONTRACTS } from "../../config/contracts";
import { formatAmount } from "../lib/format";
import { activeNetwork, publicClient } from "../rpc/client";
import { ensureAllowance, type TxExecutionContext, writeCall } from "./tx";

/**
 * "STAKE NUSD" in the wireframe is the 0xFi lending pool: supply() earns the
 * lender share of borrower interest and withdraw() takes it back. There is no
 * separate staking contract, and inventing one would mean a new deployment.
 *
 * Withdrawals are bounded by `maxWithdraw`, which accounts for liquidity that
 * borrowers have already drawn — the UI quotes that number rather than the
 * supplied balance.
 *
 * The user's own position and the liquidity behind it are null when their read
 * failed: "0 supplied" for a deposit the node did not report reads as lost
 * funds, and a 0 cap would refuse every withdrawal as an invalid amount.
 */
export interface LendState {
  supplied: bigint | null;
  maxWithdraw: bigint | null;
  supplyRateWad: bigint;
  lenderRateWad: bigint;
  availableLiquidity: bigint | null;
  totalSupplied: bigint;
  totalBorrowed: bigint;
  supplyPaused: boolean;
  activated: boolean;
}

export async function loadLendState(account: Address): Promise<LendState> {
  const pool = { address: CONTRACTS.lendingPool, abi: lendingPoolAbi } as const;
  const calls = await publicClient.multicall({
    allowFailure: true,
    contracts: [
      { ...pool, functionName: "supplyBalance", args: [account] },
      { ...pool, functionName: "maxWithdraw", args: [account] },
      { ...pool, functionName: "supplyRate" },
      { ...pool, functionName: "lenderRate" },
      { ...pool, functionName: "availableLiquidity" },
      { ...pool, functionName: "totalSupplied" },
      { ...pool, functionName: "totalBorrowed" },
      { ...pool, functionName: "supplyPaused" },
      { ...pool, functionName: "activated" },
    ] as const,
  });

  const read = (index: number): bigint | null =>
    calls[index]?.status === "success" ? (calls[index]!.result as bigint) : null;
  const num = (index: number): bigint => read(index) ?? 0n;

  return {
    supplied: read(0),
    maxWithdraw: read(1),
    supplyRateWad: num(2),
    lenderRateWad: num(3),
    availableLiquidity: read(4),
    totalSupplied: num(5),
    totalBorrowed: num(6),
    // Fail closed on both switches: an unreadable flag blocks the action.
    supplyPaused: calls[7]?.status === "success" ? (calls[7]!.result as boolean) : true,
    activated: calls[8]?.status === "success" ? (calls[8]!.result as boolean) : false,
  };
}

export async function supplyNusd(params: { from: Address; amount: bigint }): Promise<Hex> {
  // Approval and supply are one user action. Pin both reads/writes to the same
  // network even if another wallet surface changes the selection mid-flight.
  const context = { network: activeNetwork, client: publicClient } satisfies TxExecutionContext;
  await ensureAllowance({
    from: params.from,
    token: CONTRACTS.nusd,
    spender: CONTRACTS.lendingPool,
    amount: params.amount,
    symbol: "NUSD",
  }, context);
  return writeCall({
    from: params.from,
    address: CONTRACTS.lendingPool,
    abi: lendingPoolAbi,
    functionName: "supply",
    args: [params.amount, params.from],
    kind: "supply",
    label: { key: "tx.supply", params: { amount: formatAmount(params.amount, 18, 2) } },
  }, context);
}

export async function withdrawNusd(params: { from: Address; amount: bigint }): Promise<Hex> {
  return writeCall({
    from: params.from,
    address: CONTRACTS.lendingPool,
    abi: lendingPoolAbi,
    functionName: "withdraw",
    args: [params.amount, params.from],
    kind: "withdraw",
    label: { key: "tx.withdraw", params: { amount: formatAmount(params.amount, 18, 2) } },
  });
}
