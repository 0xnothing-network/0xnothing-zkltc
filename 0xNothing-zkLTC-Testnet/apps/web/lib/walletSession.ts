import type { Address } from "viem";
import type { Config } from "wagmi";
import { getAccount } from "wagmi/actions";

/** Revalidate the reviewed account and connector after each asynchronous preparation step. */
export function createWalletSessionGuard(config: Config, address: Address, chainId: number): () => void {
  const connectorUid = getAccount(config).connector?.uid;
  return () => {
    const current = getAccount(config);
    if (!current.isConnected || current.address?.toLowerCase() !== address.toLowerCase()
      || current.connector?.uid !== connectorUid || current.chainId !== chainId) {
      throw new Error("Wallet changed. Review the transaction with your current account and try again.");
    }
  };
}
