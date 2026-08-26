import "server-only";

import type { Address } from "viem";
import type { PumpHolder, PumpHoldersResponse } from "@/features/pump/types";
import type { GraphTokenBalance } from "./graph";
import { integerString, safeAddress } from "./values";

/**
 * Holder list shaping shared by the indexed and the RPC path, so both return the
 * creator exactly once and with the same flag.
 */

export function normalizeGraphHolder(position: GraphTokenBalance, creator: Address): PumpHolder {
  const account = safeAddress(position.holder);
  return {
    account,
    balance: integerString(position.balance),
    isCreator: account.toLowerCase() === creator.toLowerCase(),
  };
}

export function mergeCreatorHolder(
  holders: PumpHolder[],
  creator: Address,
  creatorBalance: string,
): PumpHolder[] {
  const normalizedCreator = creator.toLowerCase();
  if (holders.some((holder) => holder.account.toLowerCase() === normalizedCreator)) {
    return holders.map((holder) =>
      holder.account.toLowerCase() === normalizedCreator
        ? { ...holder, isCreator: true }
        : holder);
  }
  return [
    ...holders,
    { account: creator, balance: integerString(creatorBalance), isCreator: true },
  ];
}

export function emptyHoldersResponse(creator: Address, configured: boolean): PumpHoldersResponse {
  return {
    holders: [],
    creator,
    totalSupply: "0",
    curveBalance: "0",
    holderCount: 0,
    source: configured ? "rpc" : "unconfigured",
    configured,
  };
}
