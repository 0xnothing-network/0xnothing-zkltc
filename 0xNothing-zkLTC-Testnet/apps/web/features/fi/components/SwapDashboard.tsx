import { SwapWorkspace } from "@fi/components/SwapWorkspace";

export function SwapDashboard() {
  return (
    <div className="fi-page fi-trade-dashboard">
      <section className="fi-primary-action fi-swap-shell" aria-label="Swap assets">
        <SwapWorkspace />
      </section>
    </div>
  );
}
