"use client";

import { useChains } from "wagmi";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { NETWORK_SHORT_NAME } from "@/config/network";
import { useEnsureChain } from "@/lib/useEnsureChain";
import { litvm } from "@/config/wagmi";

/** Explains which network the wallet is on and why actions are paused. Reads keep working. */
export function WrongNetworkBanner() {
  const { wrongNetwork, walletChainId, ensureChain, isSwitching, switchError } = useEnsureChain();
  const chains = useChains();
  if (!wrongNetwork) return null;
  const current = chains.find((chain) => chain.id === walletChainId)?.name ?? (walletChainId ? `chain ${walletChainId}` : "another network");
  return (
    <Banner
      tone="warning"
      title={`Your wallet is on ${current}.`}
      action={(
        <Button variant="warning" size="sm" loading={isSwitching} onClick={() => void ensureChain()}>
          Switch to {NETWORK_SHORT_NAME}
        </Button>
      )}
    >
      Transactions are paused until you switch to {litvm.name} (chain {litvm.id}). Market data keeps loading.
      {switchError ? " Your wallet declined the switch. Add the network manually using the RPC in the docs." : null}
    </Banner>
  );
}
