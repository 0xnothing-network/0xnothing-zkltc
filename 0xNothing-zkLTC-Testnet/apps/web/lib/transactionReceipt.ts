import type { Hash, TransactionReceipt, WaitForTransactionReceiptParameters } from "viem";

type Receipt = Pick<TransactionReceipt, "status" | "transactionHash">;
export type ReceiptFailureReason = "cancelled" | "replaced" | "reverted" | "unverified";

export class ReceiptConfirmationError extends Error {
  readonly hash: Hash;
  readonly reason: ReceiptFailureReason;

  constructor(hash: Hash, reason: ReceiptFailureReason) {
    super(reason === "cancelled"
      ? "Transaction cancelled in your wallet. The requested action was not completed."
      : reason === "replaced"
        ? "Transaction replaced with a different action. Review your wallet before trying again."
        : reason === "reverted"
          ? "Transaction reverted on-chain."
          : "A different transaction was confirmed. Review your wallet before trying again.");
    this.name = "ReceiptConfirmationError";
    this.hash = hash;
    this.reason = reason;
  }
}

/** Confirm the requested action, allowing a gas-price speed-up but no changed intent. */
export async function waitForProtocolReceipt<T extends Receipt>(
  client: { waitForTransactionReceipt(parameters: WaitForTransactionReceiptParameters): Promise<T> },
  hash: Hash,
): Promise<T> {
  let replacement: { reason: "cancelled" | "replaced" | "repriced"; hash: Hash } | undefined;
  let changedIntent: "cancelled" | "replaced" | undefined;
  const receipt = await client.waitForTransactionReceipt({
    hash,
    checkReplacement: true,
    onReplaced: ({ reason, transactionReceipt }) => {
      replacement = { reason, hash: transactionReceipt.transactionHash };
      if (reason !== "repriced") changedIntent ??= reason;
    },
  });
  const confirmedHash = receipt.transactionHash;
  if (changedIntent) {
    throw new ReceiptConfirmationError(confirmedHash, changedIntent);
  }
  if (confirmedHash.toLowerCase() !== hash.toLowerCase()
    && (replacement?.reason !== "repriced" || replacement.hash.toLowerCase() !== confirmedHash.toLowerCase())) {
    throw new ReceiptConfirmationError(confirmedHash, "unverified");
  }
  if (receipt.status !== "success") throw new ReceiptConfirmationError(confirmedHash, "reverted");
  return receipt;
}
