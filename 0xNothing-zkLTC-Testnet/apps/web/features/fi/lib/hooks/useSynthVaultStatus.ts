"use client";

import type { Address } from "viem";
import { useReadContract } from "wagmi";
import { deployment } from "@fi/config/deployment";
import { synthVaultAbi } from "@fi/lib/abis/synth";

export type SynthVaultStatus =
  | "unconfigured"
  | "disabled"
  | "checking"
  | "verification-error"
  | "activation-pending"
  | "ready";

export function useSynthVaultStatus(vault: Address | undefined) {
  // `activated()` was introduced with the shared safety-reserve deployment.
  // Legacy vaults do not expose it, so only reserve-aware deployments read it.
  const reserveAware = Boolean(
    deployment.contracts.synthSafetyReserve
    && deployment.contracts.synthFeeGaugeFactory,
  );
  const activation = useReadContract({
    address: vault,
    abi: synthVaultAbi,
    functionName: "activated",
    query: { enabled: Boolean(vault && reserveAware && deployment.synthRiskActionsEnabled) },
  });

  let status: SynthVaultStatus;
  if (!vault) status = "unconfigured";
  else if (!deployment.synthRiskActionsEnabled) status = "disabled";
  else if (!reserveAware) status = "ready";
  else if (activation.isError) status = "verification-error";
  else if (activation.data === undefined) status = "checking";
  else if (activation.data !== true) status = "activation-pending";
  else status = "ready";

  const copy: Record<SynthVaultStatus, { title: string; message: string; actionLabel: string }> = {
    unconfigured: {
      title: "Synth vault is not configured",
      message: "The selected testnet vault address is missing.",
      actionLabel: "Not deployed",
    },
    disabled: {
      title: "Synth activation pending",
      message: "Minting and collateral deposits remain disabled while the safety reserve and fee routing deployment is finalized.",
      actionLabel: "Activation pending",
    },
    checking: {
      title: "Verifying synth vault",
      message: "Checking the vault activation state on-chain.",
      actionLabel: "Verifying vault",
    },
    "verification-error": {
      title: "Synth verification unavailable",
      message: "The activation read failed, so minting and collateral deposits remain disabled.",
      actionLabel: "Verification failed",
    },
    "activation-pending": {
      title: "Synth vault is not activated",
      message: "The vault has not completed its atomic safety-reserve activation.",
      actionLabel: "Activation pending",
    },
    ready: {
      title: "Synth vault verified",
      message: "The vault is active for risk-increasing operations.",
      actionLabel: "Ready",
    },
  };

  return {
    status,
    ...copy[status],
    ready: status === "ready",
    checking: status === "checking",
    reserveAware,
    activated: reserveAware ? activation.data === true : undefined,
    refetch: activation.refetch,
  };
}
