import type { Address } from "viem";
import type { Config } from "wagmi";
import { getAccount } from "wagmi/actions";
import { PUMP_CHAIN_ID } from "@/features/pump/config";

/** Recheck the submitting wallet after every asynchronous preparation step. */
export function createPumpWalletGuard(config: Config, address: Address): () => void {
  const connectorUid = getAccount(config).connector?.uid;
  return () => {
    const current = getAccount(config);
    if (!current.isConnected || current.address?.toLowerCase() !== address.toLowerCase()
      || current.connector?.uid !== connectorUid || current.chainId !== PUMP_CHAIN_ID) {
      throw new Error("Wallet changed. Review the transaction with your current account and try again.");
    }
  };
}
