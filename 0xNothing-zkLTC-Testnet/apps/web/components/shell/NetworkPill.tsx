"use client";

import { litvm } from "@/config/wagmi";
import { NETWORK_SHORT_NAME } from "@/config/network";
import { useEnsureChain } from "@/lib/useEnsureChain";
import { cx } from "@/components/ui/cx";

/** "LiteForge · 4441" when fine; amber "Wrong network · Switch" otherwise (spec §6.2). */
export function NetworkPill({ className }: { className?: string }) {
  const { wrongNetwork, ensureChain, isSwitching } = useEnsureChain();
  if (wrongNetwork) {
    return (
      <button
        type="button"
        onClick={() => void ensureChain()}
        disabled={isSwitching}
        className={cx(
          "inline-flex h-9 items-center gap-2 rounded-full border border-warning/40 bg-warning-bg px-3 font-ui text-[13px] font-medium text-warning focus-ring",
          className,
        )}
      >
        <span aria-hidden="true" className="size-2 rounded-full bg-warning" />
        {isSwitching ? "Switching…" : <>Wrong network<span className="max-sm:hidden"> · Switch</span></>}
      </button>
    );
  }
  return (
    <span
      className={cx("inline-flex h-9 items-center gap-2 rounded-full border border-line bg-surface-2 px-3 font-ui text-[13px] text-fg-2", className)}
      title={`${litvm.name}, chain ${litvm.id}`}
    >
      <span aria-hidden="true" className="size-2 rounded-full bg-positive" />
      {NETWORK_SHORT_NAME}
      <span className="font-num tnum text-fg-3 max-sm:hidden">· {litvm.id}</span>
    </span>
  );
}
