import { cx } from "./cx";
import { ExternalLink } from "@/components/ExternalLink";

export type TxStepStatus = "pending" | "active" | "done" | "failed";

export interface TxStep {
  id: string;
  label: string;
  status: TxStepStatus;
  /** Explorer link for a mined step. */
  href?: string;
  /** Human error for a failed step. */
  error?: string;
}

const dot: Record<TxStepStatus, string> = {
  pending: "border-line-strong text-fg-3",
  active: "border-accent text-accent-text",
  done: "border-positive bg-positive text-[#04130B]",
  failed: "border-negative bg-negative text-[#1F0308]",
};

/** Inline transaction stepper: approve? → sign → confirm. Results announced politely. */
export function TxStepper({ steps, onRetry, className }: { steps: ReadonlyArray<TxStep>; onRetry?: () => void; className?: string }) {
  return (
    <ol className={cx("grid gap-3", className)} aria-live="polite">
      {steps.map((step, index) => (
        <li key={step.id} className="flex items-start gap-3">
          <span className={cx("grid size-6 shrink-0 place-items-center rounded-full border-2 font-num text-[11px] font-semibold", dot[step.status])}>
            {step.status === "done" ? "✓" : step.status === "failed" ? "!" : step.status === "active"
              ? <span className="size-3 rounded-full border-2 border-current border-r-transparent animate-spin motion-reduce:animate-none" aria-hidden="true" />
              : index + 1}
          </span>
          <div className="min-w-0 pt-0.5 font-ui text-sm">
            <p className={step.status === "pending" ? "text-fg-3" : "text-fg"}>
              {step.label}
              <span className="sr-only"> — {step.status}</span>
            </p>
            {step.href && step.status === "done" ? (
              <ExternalLink href={step.href} className="text-xs text-accent-text underline-offset-2 hover:underline focus-ring">View on explorer</ExternalLink>
            ) : null}
            {step.status === "failed" ? (
              <p role="alert" className="text-xs text-negative">
                {step.error ?? "Transaction failed."}
                {onRetry ? <button type="button" onClick={onRetry} className="ml-2 underline focus-ring">Retry</button> : null}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
