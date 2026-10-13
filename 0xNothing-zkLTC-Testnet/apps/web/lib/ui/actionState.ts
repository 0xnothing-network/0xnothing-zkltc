/**
 * Resolves the single "next real step" for a transactional CTA (spec §4.4 ActionButton, §6):
 *   Connect wallet → Switch to LiteForge → Enter amount → Insufficient X →
 *   Approve X → {verb} → Confirm in wallet… → Confirming…
 * Pure so it can be unit-tested and shared by Pump, Fi and Pixel forms.
 */

export type ActionKind = "connect" | "switch" | "blocked" | "approve" | "submit" | "pending";

export interface ActionInput {
  verb: string;
  isConnected: boolean;
  wrongNetwork: boolean;
  networkName?: string;
  /** Amount required and not entered / zero. */
  needsAmount?: boolean;
  /** Token symbol whose balance is insufficient, if any. */
  insufficient?: string | null;
  /** Any other blocking reason, shown verbatim (e.g. "Waiting for fresh price"). */
  blockedReason?: string | null;
  /** Token symbol that must be approved first, if any. */
  approve?: string | null;
  phase?: "idle" | "signing" | "confirming";
  quoteLoading?: boolean;
}

export interface ActionState {
  kind: ActionKind;
  label: string;
  disabled: boolean;
}

export function resolveAction(input: ActionInput): ActionState {
  const network = input.networkName ?? "LiteForge";
  if (input.phase === "signing") return { kind: "pending", label: "Confirm in wallet…", disabled: true };
  if (input.phase === "confirming") return { kind: "pending", label: "Confirming…", disabled: true };
  if (!input.isConnected) return { kind: "connect", label: "Connect wallet", disabled: false };
  if (input.wrongNetwork) return { kind: "switch", label: `Switch to ${network}`, disabled: false };
  if (input.blockedReason) return { kind: "blocked", label: input.blockedReason, disabled: true };
  if (input.needsAmount) return { kind: "blocked", label: "Enter amount", disabled: true };
  if (input.insufficient) return { kind: "blocked", label: `Insufficient ${input.insufficient}`, disabled: true };
  if (input.quoteLoading) return { kind: "blocked", label: "Getting quote…", disabled: true };
  if (input.approve) return { kind: "approve", label: `Approve ${input.approve}`, disabled: false };
  return { kind: "submit", label: input.verb, disabled: false };
}
