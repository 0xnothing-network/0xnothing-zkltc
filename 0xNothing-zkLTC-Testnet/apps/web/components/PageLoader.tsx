const LOADER_BLOCKS = Array.from({ length: 12 });
const COMPACT_LOADER_BLOCKS = Array.from({ length: 8 });

export function PixelLoadingIndicator({ compact = false }: { compact?: boolean }) {
  const blocks = compact ? COMPACT_LOADER_BLOCKS : LOADER_BLOCKS;
  return (
    <div className={compact ? "pixel-loader-track pixel-loader-track-compact" : "pixel-loader-track"} aria-hidden="true">
      {blocks.map((_, index) => (
        <span key={index} style={{ animationDelay: `${index * 55}ms` }} />
      ))}
    </div>
  );
}

export function PageLoader({ embedded = false }: { embedded?: boolean }) {
  return (
    <div className={`pixel-shell flex flex-col items-center justify-center overflow-hidden ${embedded ? "min-h-[calc(100dvh-64px)]" : "min-h-[100dvh]"}`} role="status" aria-label="Loading">
      <div className="pixel-grid-bg" />
      <div className="pixel-noise" />
      <div className="pixel-loader-card">
        <div className="pixel-loader-logo" aria-hidden="true">N</div>
        <PixelLoadingIndicator />
        <span className="pixel-loader-label">LOADING</span>
      </div>
    </div>
  );
}
