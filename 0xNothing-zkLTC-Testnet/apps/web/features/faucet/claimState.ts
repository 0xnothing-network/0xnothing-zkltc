export type FaucetClaimReason =
  | "offline"
  | "connect"
  | "wrong-chain"
  | "loading"
  | "paused"
  | "cooldown"
  | "empty"
  | "daily-cap"
  | "ready";

export type FaucetClaimInput = {
  configured: boolean;
  connected: boolean;
  wrongChain: boolean;
  submitting: boolean;
  pending: boolean;
  paused?: boolean;
  now: number;
  readyAt?: number;
  nativeDrip?: bigint;
  nusdDrip?: bigint;
  faucetNativeBalance?: bigint;
  faucetNusdBalance?: bigint;
  dailyNativeRemaining?: bigint;
  dailyNusdRemaining?: bigint;
};

export type FaucetClaimState = {
  disabled: boolean;
  label: string;
  reason: FaucetClaimReason;
  cooldownRemaining: number;
};

export function utcDay(timestampSeconds: number): number {
  return Math.floor(timestampSeconds / 86_400);
}

export function dailyRemaining(dispensed: bigint, cap: bigint, storedDay: bigint, nowDay: bigint): bigint {
  if (nowDay !== storedDay) return cap;
  return cap > dispensed ? cap - dispensed : 0n;
}

export function cooldownRemaining(readyAt: number | undefined, now: number): number {
  if (!readyAt || readyAt <= now) return 0;
  return readyAt - now;
}

export function formatCooldown(seconds: number): string {
  const remaining = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(remaining / 3_600);
  const minutes = Math.floor((remaining % 3_600) / 60);
  const secs = remaining % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

export function resolveFaucetClaim(input: FaucetClaimInput): FaucetClaimState {
  if (!input.configured) {
    return { disabled: true, label: "Faucet not configured", reason: "offline", cooldownRemaining: 0 };
  }
  if (!input.connected) {
    return { disabled: true, label: "Connect wallet above", reason: "connect", cooldownRemaining: 0 };
  }
  if (input.wrongChain) {
    return { disabled: true, label: "Switch to LitVM", reason: "wrong-chain", cooldownRemaining: 0 };
  }

  const remaining = cooldownRemaining(input.readyAt, input.now);
  if (input.submitting) {
    return { disabled: true, label: "Confirming transaction", reason: "ready", cooldownRemaining: remaining };
  }
  if (input.pending) {
    return { disabled: true, label: "Reading faucet", reason: "loading", cooldownRemaining: remaining };
  }
  if (input.paused) {
    return { disabled: true, label: "Faucet paused", reason: "paused", cooldownRemaining: remaining };
  }
  if (remaining > 0) {
    return {
      disabled: true,
      label: `Wait ${formatCooldown(remaining)}`,
      reason: "cooldown",
      cooldownRemaining: remaining,
    };
  }

  const nativeDrip = input.nativeDrip ?? 0n;
  const nusdDrip = input.nusdDrip ?? 0n;
  if (
    (input.faucetNativeBalance !== undefined && input.faucetNativeBalance < nativeDrip)
    || (input.faucetNusdBalance !== undefined && input.faucetNusdBalance < nusdDrip)
  ) {
    return { disabled: true, label: "Faucet is empty", reason: "empty", cooldownRemaining: 0 };
  }
  if (
    (input.dailyNativeRemaining !== undefined && input.dailyNativeRemaining < nativeDrip)
    || (input.dailyNusdRemaining !== undefined && input.dailyNusdRemaining < nusdDrip)
  ) {
    return { disabled: true, label: "Daily cap reached", reason: "daily-cap", cooldownRemaining: 0 };
  }

  return { disabled: false, label: "Claim testnet tokens", reason: "ready", cooldownRemaining: 0 };
}
