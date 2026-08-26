export default function SwapLoading() {
  return (
    <main className="fi-page fi-trade-dashboard" aria-busy="true" aria-label="Loading swap workspace">
      <section className="fi-primary-action fi-swap-shell">
        <section className="fi-panel fi-sticky-panel fi-swap-loading-card" role="status">
          <div className="fi-panel-heading">
            <div><span className="fi-loading-line fi-loading-title" /></div>
            <span className="fi-loading-line fi-loading-status" />
          </div>
          <div className="fi-form">
            <div className="fi-loading-amount"><span /><strong /></div>
            <div className="fi-loading-route-dot" />
            <div className="fi-loading-amount"><span /><strong /></div>
            <div className="fi-loading-details"><span /><span /><span /></div>
            <span className="fi-loading-button" />
          </div>
          <span className="sr-only">Loading swap routes and balances</span>
        </section>
      </section>
    </main>
  );
}
