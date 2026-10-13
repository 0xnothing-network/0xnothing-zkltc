"use client";

import { resolveAction, type ActionInput } from "@/lib/ui/actionState";
import { Button, type ButtonSize } from "./Button";

export interface ActionButtonProps extends ActionInput {
  onConnect: () => void;
  onSwitch: () => void;
  onApprove?: () => void;
  onSubmit: () => void;
  /** Submit colour, e.g. "buy" / "sell" for trade panels. */
  submitVariant?: "primary" | "buy" | "sell" | "danger";
  size?: ButtonSize;
  className?: string;
}

/**
 * Smart CTA: the label always states the next real step (spec §4.4). Blocked
 * reasons are rendered as the visible label, never a silent disabled button.
 */
export function ActionButton({
  onConnect, onSwitch, onApprove, onSubmit, submitVariant = "primary", size = "lg", className, ...input
}: ActionButtonProps) {
  const state = resolveAction(input);
  const variant = state.kind === "switch" ? "warning" : state.kind === "submit" ? submitVariant : "primary";
  const onClick = state.kind === "connect" ? onConnect
    : state.kind === "switch" ? onSwitch
    : state.kind === "approve" ? onApprove
    : state.kind === "submit" ? onSubmit
    : undefined;
  return (
    <Button
      variant={variant}
      size={size}
      block
      disabled={state.disabled}
      loading={state.kind === "pending"}
      onClick={onClick}
      className={className}
    >
      {state.label}
    </Button>
  );
}
