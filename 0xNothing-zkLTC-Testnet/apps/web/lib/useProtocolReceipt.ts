"use client";

import { useState } from "react";
import { useWaitForTransactionReceipt } from "wagmi";
import type { Hash } from "viem";
import type { litvm } from "@/config/wagmi";
import { ReceiptConfirmationError } from "@/lib/transactionReceipt";

type Replacement = {
  requestedHash: Hash;
  confirmedHash: Hash;
  reason: "repriced" | "cancelled" | "replaced";
};

/** A wallet cancellation receipt must never confirm a mint, listing or purchase. */
export function useProtocolReceipt({ chainId, hash }: { chainId: typeof litvm.id; hash?: Hash }) {
  const [replacement, setReplacement] = useState<Replacement>();
  const query = useWaitForTransactionReceipt({
    chainId,
    hash,
    checkReplacement: true,
    onReplaced: ({ reason, transactionReceipt }) => {
      if (!hash) return;
      setReplacement((previous) => {
        // Speeding up an already changed action cannot restore its original intent.
        if (previous?.requestedHash === hash && previous.reason !== "repriced") {
          return { ...previous, confirmedHash: transactionReceipt.transactionHash };
        }
        return { requestedHash: hash, confirmedHash: transactionReceipt.transactionHash, reason };
      });
    },
  });

  const current = replacement?.requestedHash === hash ? replacement : undefined;
  let failure: ReceiptConfirmationError | undefined;
  if (current && current.reason !== "repriced") {
    failure = new ReceiptConfirmationError(current.confirmedHash, current.reason);
  } else if (hash && query.data?.transactionHash
    && query.data.transactionHash.toLowerCase() !== hash.toLowerCase()
    && (!current || current.confirmedHash.toLowerCase() !== query.data.transactionHash.toLowerCase())) {
    // A replacement already cached by another observer has no callback history here.
    // Fail closed rather than claiming the requested action executed.
    failure = new ReceiptConfirmationError(query.data.transactionHash, "unverified");
  }

  if (!failure) return query;
  return {
    ...query,
    data: undefined,
    error: failure,
    isSuccess: false,
    isError: true,
    isLoading: false,
    isPending: false,
    status: "error" as const,
  };
}
